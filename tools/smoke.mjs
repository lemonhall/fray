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
  // 记下"连接什么时候被关了"。跨境链路上偶发一次断流并不稀奇，但**超时的报错里
  // 必须能看出是"连接断了"还是"服务端压根没发"**——否则每次偶发都得重新猜一遍。
  let closedCode = null;
  ws.addEventListener("close", ev => { closedCode = ev.code; });
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
        reject(new Error(`等待消息超时${closedCode === null ? "" : `（连接已被关闭 code=${closedCode}）`}`));
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

  // 邀请链接会被人传来传去，散掉的房间必须得到一个干脆的"没有这一间"，
  // 而不是一条挂在那儿等超时的连接（前端的 `?room=` 就靠这个说人话）。
  const ghost = await api(`/v1/${TENANT}/rooms/ZZZZZZ/socket`, { token });
  check("过期邀请链接（房间不存在）被明确拒绝",
    ghost.status === 404 && ghost.data?.error === "unknown_room",
    `${ghost.status} ${ghost.data?.error}`);

  const host = connect(`${WS_BASE}/v1/${TENANT}/rooms/${roomId}/socket?token=${encodeURIComponent(token)}`);
  await host.opened;
  const hello = await host.next(m => m.t === "hello");
  check("握手后收到 hello 与名册", hello.you?.id === playerId && !!hello.room, `房主=${hello.room?.host}`);

  host.send({ t: "bots", n: 5 });
  const withBots = await host.next(m => m.t === "room" && m.bots === 5);
  check("房主把机器人调到 5 个", !!withBots);

  // ---------------------------------------------------------------- 举手与开局闸门
  // 第二个真人：他还没举手的时候，房主按开打必须被服务端挡下来（界面上的按钮
  // 变灰只是投影，真正的拒绝在这条断言里）。
  const peer = await api(`/v1/${TENANT}/guest`, { method: "POST", body: { name: "冒烟陪练" } });
  const mate = connect(`${WS_BASE}/v1/${TENANT}/rooms/${roomId}/socket?token=${encodeURIComponent(peer.data.token)}`);
  await mate.opened;
  const mateHello = await mate.next(m => m.t === "hello");
  check("第二个真人进得来，名册两边一致",
    mateHello.room?.members?.length === 2 && mateHello.room.you.host === false,
    `名册 ${mateHello.room?.members?.length} 人`);
  const sideShown = (await host.next(m => m.t === "room" && m.members.length === 2));
  check("候场名册里两个人都在，且都没举手",
    sideShown.members.every(m => m.rdy === 0) && sideShown.allReady === false);

  host.send({ t: "start" });
  const refused = await host.next(m => m.t === "error");
  check("有人没举手时，房主开不了局",
    refused.error === "not_ready" && (refused.pending || []).includes("冒烟陪练"),
    `pending=${JSON.stringify(refused.pending)}`);

  mate.send({ t: "ready", v: 1 });
  // 断言里必须带 `members.length === 2`：房主自己进场时也广播过一条"1 人名册"，
  // 那时候 allReady 天然是 true，不锁人数就会抓到那条旧消息（踩过一次）。
  const allReady = await host
    .next(m => m.t === "room" && m.members.length === 2 && m.allReady === true, 5000)
    .catch(() => null);
  check("陪练举手之后，两边都看到全员就绪",
    !!allReady && allReady.members.some(m => m.rdy === 1), "allReady=true");

  // 选边：只有候场阶段能改，改完服务端要认。
  mate.send({ t: "team", tm: 1 });
  const sided = await host
    .next(m => m.t === "room" && m.members.length === 2 && m.members.some(x => x.tm === 1), 5000)
    .catch(() => null);
  check("真人可以自己选边（选完立刻广播）", !!sided, "红队 1 人");

  const startedAt = Date.now();
  host.send({ t: "start" });
  const map = await host.next(m => m.t === "map");
  check("开局下发地图", typeof map.grid === "string" && Number.isInteger(map.seed), `seed=${map.seed}`);

  const firstFrame = await host.next(m => m.t === "s", 3000);
  check("开打后 3 秒内有第一帧快照", true, `${Date.now() - startedAt}ms，tick=${firstFrame.tk}`);
  check("快照里能看到我自己（含私有字段）",
    !!meIn(firstFrame, playerId) && typeof meIn(firstFrame, playerId).lv === "number");
  const humans = firstFrame.a.filter(a => a.k === 1).length;
  // 机器人有几只在第一帧里**看得见**，取决于出生点周围有没有草丛——所以这里累计
  // 一小段时间，验的是"机器人确实在场上"，而不是"第一帧恰好瞟到一个"。
  let botsSeen = 0;
  const botDeadline = Date.now() + 6000;
  while (Date.now() < botDeadline && !botsSeen) {
    const frame = await host.next(m => m.t === "s", 2000).catch(() => null);
    if (!frame) break;
    botsSeen = frame.a.filter(a => a.k === 0).length;
  }
  check("人机同场：2 名真人 + 机器人", humans === 2 && botsSeen >= 1,
    `真人 ${humans} / 机器人 ${botsSeen}`);

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

  // ---------------------------------------------------------------- 踢人
  // 房主把陪练请出去：对方要收到明确的"被踢了"（而不是一句冷冰冰的断线），
  // 名册当场减员，而且他十分钟内不能再进这一间。
  host.send({ t: "kick", id: peer.data.playerId });
  const gotKicked = await mate.next(m => m.t === "kicked", 5000).catch(() => null);
  check("被踢的人收到明确的 kicked 通知", !!gotKicked);
  const afterKick = await host.next(m => m.t === "room" && m.members.length === 1, 5000).catch(() => null);
  check("踢完之后名册里只剩房主", !!afterKick);
  const back = connect(`${WS_BASE}/v1/${TENANT}/rooms/${roomId}/socket?token=${encodeURIComponent(peer.data.token)}`);
  back.opened.catch(() => {});
  const rejoin = await back.next(m => m.t === "error", 5000).catch(() => null);
  check("被踢的人十分钟内进不来", rejoin?.error === "kicked", `error=${rejoin?.error}`);

  // ---------------------------------------------------------------- 谢客房
  // 房主关掉"允许中途加入"之后：开打之前照收人，开打之后新人被挡在门外，
  // 而已经在房里的人重连不受影响（那是掉线，不是闯门）。
  const shut = await api(`/v1/${TENANT}/rooms`, {
    method: "POST", token, body: { name: "谢客房", bots: 1, mode: "control", joinLive: false },
  });
  check("建房时能关掉中途加入", shut.status === 201 && shut.data?.room?.join === false,
    `join=${shut.data?.room?.join}`);
  const shutRoom = shut.data?.roomId;
  if (shutRoom) {
    const keeper = connect(`${WS_BASE}/v1/${TENANT}/rooms/${shutRoom}/socket?token=${encodeURIComponent(token)}`);
    await keeper.opened;
    await keeper.next(m => m.t === "hello");
    keeper.send({ t: "start" });
    await keeper.next(m => m.t === "map");
    await keeper.next(m => m.t === "s", 4000);
    const late = connect(`${WS_BASE}/v1/${TENANT}/rooms/${shutRoom}/socket?token=${encodeURIComponent(peer.data.token)}`);
    late.opened.catch(() => {});
    const door = await late.next(m => m.t === "error", 5000).catch(() => null);
    check("开着谢客的对局里，新人被挡在门外", door?.error === "join_closed", `error=${door?.error}`);
    keeper.ws.close();
  }

  host.ws.close();
  await sleep(50);
}

await main().catch(error => check("冒烟脚本自身没崩", false, String(error?.message || error)));

const failed = results.filter(r => !r.ok);
console.log(`\n—— 冒烟结果 ——\n${results.length - failed.length} / ${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
