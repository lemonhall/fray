/**
 * 冒烟：不开浏览器，只用 HTTP + WebSocket 把"最小可玩一局"走一遍。
 *
 * 和 `tools/e2e-local.mjs` 的分工：E2E 开真 Chrome，验的是 UI 与渲染这条线；
 * 这里只验**服务端契约**（HTTP 路由 + 线协议），几秒钟跑完，适合每次部署后立刻自检。
 *
 *   node tools/smoke.mjs                                     # 默认打本机 127.0.0.1:8790
 *   $env:SMOKE_BASE='https://fray-api.lemonhall.me'; node tools/smoke.mjs
 *
 * 出口码：全过 0，有任何一条不过 1。
 */

const BASE = (process.env.SMOKE_BASE || process.env.FRAY_API || "http://127.0.0.1:8790").replace(/\/+$/u, "");
const TENANT = process.env.SMOKE_TENANT || "neon";
const WS_BASE = BASE.replace(/^http/u, "ws");

const results = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function check(name, ok, note = "") {
  results.push({ name, ok });
  console.log(`${ok ? "✔" : "✘"} ${name}${note ? ` — ${note}` : ""}`);
}

async function api(path, { method = "GET", token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* 有些响应没有 body */ }
  return { status: res.status, data };
}

/** 一个极简的 WebSocket 客户端：消息先进队列，"等某条消息"可以先到先取、也可以等未来。 */
function connect(url) {
  const ws = new WebSocket(url);
  const queue = [];
  const waiters = [];
  ws.addEventListener("message", ev => {
    let msg;
    try { msg = JSON.parse(String(ev.data)); } catch { return; }
    const hit = waiters.findIndex(w => w.match(msg));
    if (hit >= 0) { const [w] = waiters.splice(hit, 1); clearTimeout(w.timer); w.resolve(msg); return; }
    queue.push(msg);
  });
  const next = (match, ms = 5000) => {
    const hit = queue.findIndex(match);
    if (hit >= 0) return Promise.resolve(queue.splice(hit, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { match, resolve, timer: setTimeout(() => {
        const i = waiters.indexOf(w);
        if (i >= 0) waiters.splice(i, 1);
        reject(new Error("等待消息超时"));
      }, ms) };
      waiters.push(w);
    });
  };
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve("open"));
    ws.addEventListener("close", ev => reject(new Error(`closed ${ev.code}`)));
    ws.addEventListener("error", () => reject(new Error("WebSocket 连不上")));
  });
  return { ws, next, opened, send: payload => ws.send(JSON.stringify(payload)) };
}

/** 快照里"我"是哪个实体：用 playerId 匹配，而不是靠别名字段。 */
const meIn = (snapshot, playerId) => (snapshot?.a || []).find(a => a.ow === playerId) || null;

async function main() {
  const health = await api("/v1/health");
  check("健康检查", health.status === 200 && health.data?.ok === true, `${BASE} service=${health.data?.service}`);

  const listed = await api(`/v1/${TENANT}/rooms`);
  check("房间目录可读", listed.status === 200 && Array.isArray(listed.data?.rooms),
    `租户 ${TENANT}，当前 ${listed.data?.rooms?.length ?? "?"} 个房间`);

  const guest = await api(`/v1/${TENANT}/guest`, { method: "POST", body: { name: "冒烟客" } });
  check("游客令牌签发", guest.status === 200 && !!guest.data?.token);
  if (!guest.data?.token) return;
  const { token, playerId } = guest.data;

  const created = await api(`/v1/${TENANT}/rooms`, {
    method: "POST", token, body: { name: "冒烟房", bots: 3, mode: "control" },
  });
  check("建房 + 开局前就投放机器人", created.status === 201 && created.data?.ok === true,
    `roomId=${created.data?.roomId}`);
  if (!created.data?.ok) return;
  const roomId = created.data.roomId;
  check("机器人数量进了房间目录", created.data.room?.bots === 3, `bots=${created.data.room?.bots}`);

  const again = await api(`/v1/${TENANT}/rooms`);
  check("新房立刻出现在目录里", (again.data?.rooms || []).some(r => r.id === roomId));

  const anon = connect(`${WS_BASE}/v1/${TENANT}/rooms/${roomId}/socket`);
  const anonDenied = await anon.opened.then(() => false).catch(() => true);
  check("不带令牌的 WebSocket 被拒", anonDenied);

  const host = connect(`${WS_BASE}/v1/${TENANT}/rooms/${roomId}/socket?token=${encodeURIComponent(token)}`);
  await host.opened;
  const hello = await host.next(m => m.t === "hello");
  check("握手后收到 hello 与名册", hello.you?.id === playerId && !!hello.room, `房主=${hello.room?.host}`);

  host.send({ t: "bots", n: 5 });
  const withBots = await host.next(m => m.t === "room" && m.bots === 5);
  check("房主把机器人调到 5 个", !!withBots);

  const startedAt = Date.now();
  host.send({ t: "start" });
  const map = await host.next(m => m.t === "map");
  check("开局下发地图", typeof map.grid === "string" && Number.isInteger(map.seed), `seed=${map.seed}`);

  const firstFrame = await host.next(m => m.t === "s", 3000);
  check("开打后 3 秒内有第一帧快照", true, `${Date.now() - startedAt}ms，tick=${firstFrame.tk}`);
  check("快照里能看到我自己（含私有字段）",
    !!meIn(firstFrame, playerId) && typeof meIn(firstFrame, playerId).lv === "number");
  const bots = firstFrame.a.filter(a => a.k === 0).length;
  const humans = firstFrame.a.filter(a => a.k === 1).length;
  check("人机同场：1 名真人 + 机器人", humans === 1 && bots >= 1, `真人 ${humans} / 机器人 ${bots}`);

  const before = meIn(firstFrame, playerId);
  const baseTick = firstFrame.tk;
  let latest = firstFrame;
  // 一路朝右推，直到服务端认账为止。用**截止时间**而不是固定轮数：
  // 隔着代理连线上时单次往返可能几百毫秒，固定轮数会变成一条爱抖的断言。
  const deadline = Date.now() + 10000;
  let sq = 0;
  while (Date.now() < deadline) {
    // 新协议：一条命令自带序号与格数（25Hz 上行、60Hz 模拟 → 大约 2 格）。
    // `k` 继续带着，是为了让线上还没更新的老服务端也能听懂。
    host.send({ t: "in", sq: ++sq, mx: 1, my: 0, k: 2, a: 0, f: 0, r: 310, n: 2 });
    await sleep(40);
    const frame = await host.next(m => m.t === "s" && m.tk > latest.tk, 1500).catch(() => null);
    if (frame) latest = frame;
    const moved = meIn(latest, playerId);
    if (moved && moved.x - before.x > 40) break;
  }
  const after = meIn(latest, playerId);
  check("服务端认可我的移动（权威坐标）", !!after && after.x - before.x > 40,
    `x ${before?.x} → ${after?.x}`);
  check("快照带回权威确认点（ak/ax/ay）", Number.isFinite(after?.ak) && Number.isFinite(after?.ax) && after.ak > 0,
    `ack=${after?.ak} @ (${after?.ax}, ${after?.ay})`);
  check("世界持续推进（tick 单调递增）", latest.tk > baseTick, `tick ${baseTick} → ${latest.tk}`);

  host.ws.close();
  await sleep(50);
}

await main().catch(error => check("冒烟脚本自身没崩", false, String(error?.message || error)));

const failed = results.filter(r => !r.ok);
console.log(`\n—— 冒烟结果 ——\n${results.length - failed.length} / ${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
