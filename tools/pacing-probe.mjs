/**
 * 快照节奏探针：只回答一个问题——**画面为什么会像幻灯片**。
 *
 * 它不去猜，而是把快照当成唯一的证据：记下每一帧的到达时刻、世界模拟时间（`tm`）、
 * 以及每个实体在帧间的位移，然后**照着客户端的插值规则重算一遍**，看看最后落到
 * 屏幕上的是不是均匀的位移。
 *
 * 要看的两个量：
 *   - `arrivalMs`：两帧快照**到达**的间隔（真实链路上的节奏）；
 *   - `worldMs`：两帧快照之间**世界**推进了多少毫秒。
 * 两者如果对不上，客户端就会一会儿追、一会儿等，眼睛看到的就是"幻灯片"。
 *
 * 用法（需要本机 8790 上跑着 `npx wrangler dev`）：
 *   node tools/pacing-probe.mjs
 *   PROBE_DELAY=100 PROBE_JITTER=40 node tools/pacing-probe.mjs
 *   PROBE_DIRECT=1 node tools/pacing-probe.mjs     # 不挂代理，走 localhost
 *
 * 重放与统计的"尺子"在 `pacing-stats.mjs`：本文件只负责采集与出报告。
 */

import { startLatencyProxy } from "./latency-proxy.mjs";
import {
  gaps, headStepStats, jitterOf, percentile, replay, round,
} from "./pacing-stats.mjs";

const DEV_PORT = Number(process.env.PROBE_DEV_PORT) || 8790;
const PROXY_PORT = Number(process.env.PROBE_PORT) || 8899;
const DELAY = Number(process.env.PROBE_DELAY ?? 100);
const JITTER = Number(process.env.PROBE_JITTER ?? 30);
const SECONDS = Number(process.env.PROBE_SECONDS ?? 8);
const DIRECT = process.env.PROBE_DIRECT === "1";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const TENANT = "neon";

async function until(fn, { timeout = 25000, every = 200, what = "条件" } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(every);
  }
  throw new Error(`等待超时：${what}`);
}

/**
 * `PROBE_BASE` 直接指向一个真实后端（例如 `https://fray-api.lemonhall.me`），
 * 用来量"线上"的节奏——本机的 `wrangler dev` 在浏览器轮询 + 本地 D1 的夹击下会
 * 整段冻结，量出来的长停不代表生产。
 */
const base = process.env.PROBE_BASE
  || (DIRECT ? `http://127.0.0.1:${DEV_PORT}` : `http://127.0.0.1:${PROXY_PORT}`);
/** 报告里那条"链路是什么"的说明：直连、本机、还是挂了人工延迟的代理。 */
const linkLabel = process.env.PROBE_BASE ? `直连 ${base}`
  : DIRECT ? `localhost:${DEV_PORT}`
    : `+${DELAY}ms 单向 / ${JITTER}ms 抖动`;

async function json(method, path, body, token) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(base + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path} → ${response.status} ${JSON.stringify(data)}`);
  return data;
}

// ------------------------------------------------------------------ 跑

const proxy = DIRECT ? null : await startLatencyProxy({
  port: PROXY_PORT, targetPort: DEV_PORT, delayMs: DELAY, jitterMs: JITTER,
});

const guest = await json("POST", `/v1/${TENANT}/guest`, { name: "节奏探针" });
const room = await json("POST", `/v1/${TENANT}/rooms`, { name: "节奏测试", mode: "control", bots: 4 }, guest.token);

const wsUrl = `${base.replace(/^http/u, "ws")}/v1/${TENANT}/rooms/${room.roomId}/socket?token=${encodeURIComponent(guest.token)}`;
const ws = new WebSocket(wsUrl);
const snaps = [];
const log = [];
const opened = new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve);
  ws.addEventListener("error", () => reject(new Error("WebSocket 连接失败")));
});
ws.addEventListener("message", event => {
  let msg;
  try { msg = JSON.parse(event.data); } catch { return; }
  log.push({ at: Date.now(), t: msg.t, tk: msg.tk });
  if (msg.t === "s") snaps.push({ at: Date.now(), wt: msg.wt || 0, tm: msg.tm, tk: msg.tk, a: msg.a });
  if (msg.t === "hello") ws.send(JSON.stringify({ t: "start" }));
});
await opened;
await until(() => snaps.length >= 4, { what: "第一帧快照" });

/** 用 n=0 的输入当心跳，每秒 25 条——这正是浏览器上行的那条流。 */
let sq = 0;
/**
 * 顺带量一下**探针自己的事件循环**有没有卡：心跳本来每 40ms 一条，如果它也跟着停了
 * 几百毫秒，那么"到达间隔抖动"里就混进了测量工具自己的锅，不能全算在服务端头上。
 */
const pumpAt = [];
const pump = setInterval(() => {
  if (ws.readyState !== 1) return;
  pumpAt.push(Date.now());
  ws.send(JSON.stringify({ t: "in", sq: ++sq, mx: 0, my: 0, n: 0, k: 0, a: 0, f: 0, act: 0, r: 310 }));
}, 40);
await sleep(SECONDS * 1000);
clearInterval(pump);
ws.close();
if (proxy) await proxy.close();

/**
 * 只从"世界真的开始动了"那一刻起算：服务端在开局前会先推一张 `tm = 0` 的静态快照，
 * 拿它当时间线起点，渲染头会被正确地放到 `-INTERP_DELAY`，然后一直等世界的第一格。
 * 真实客户端不会看到这一幕（`buildView` 要等地图和 live 快照），探针必须自己跳过，
 * 否则量到的全是它自己的空转。
 */
const live = snaps.findIndex(s => s.tm > 0);
const timeline = live > 0 ? snaps.slice(live) : snaps;
if (process.env.PROBE_DUMP) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(process.env.PROBE_DUMP, JSON.stringify(timeline.map(s => [Math.round(s.at), s.tm, s.tk])));
}

/** 只用一直存在的实体（机器人可能中途死掉），否则位移序列会断。 */
const seen = new Map();
for (const s of timeline) for (const e of s.a) seen.set(e.i, (seen.get(e.i) || 0) + 1);
const ids = [...seen.entries()].filter(([, n]) => n >= timeline.length * .8).map(([id]) => id).slice(0, 5);

const { arrival, world, tk } = gaps(timeline);
/**
 * 数据流本身的"长停"（相邻两帧间隔 > 200ms）：这些帧画面必然冻住，客户端再聪明
 * 也没用——它手里没有数据。把它们单独数出来，免得跟"头部算法不好"混为一谈。
 */
const longGaps = arrival.filter(v => v > 200);
const stallsMs = longGaps.reduce((a, b) => a + b, 0);
/** 长停发生的时间点（毫秒，相对时间线起点）——用来判断是"开局抖动"还是"持续发生"。 */
const stallAt = [];
for (let i = 1; i < timeline.length; i++) {
  if (timeline[i].at - timeline[i - 1].at > 200) stallAt.push(Math.round(timeline[i].at - timeline[0].at));
}

const { perEntity, perFrameDelta, headGap, headStep, headStepClean, frames, frozen, bigSteps, edgeHold, jumps } =
  replay(timeline, ids, { debug: process.env.PROBE_DEBUG === "1" });
const steps = [...perEntity.values()].flat();
/** 只留"真的在动的实体"：静止的机器人在每一帧都是 0，会把中位数拉到没有意义。 */
const moving = [...perEntity.values()].filter(v => v.length && percentile(v, .5) > .15).flat();
if (process.env.PROBE_DEBUG === "1") {
  console.log("ids:", ids, "timeline:", timeline.length, "q a-len:", timeline[4]?.a.length, timeline[9]?.a.length);
  console.log("perEntity sizes:", [...perEntity.entries()].map(([k, v]) => [k, v.length]));
  console.log("frameDelta head:", perFrameDelta.slice(20, 50).map(v => round(v, 2)));
  console.log("headGap:", headGap.slice(20, 50));
  console.log("headStep ms:", headStep.slice(0, 40).map(v => round(v * 1000, 2)));
  console.log("headStep 分布: <8ms", headStep.filter(v => v * 1000 < 8).length,
    "8~25ms", headStep.filter(v => v * 1000 >= 8 && v * 1000 <= 25).length,
    ">25ms", headStep.filter(v => v * 1000 > 25).length);
}

console.log(JSON.stringify({
  link: linkLabel,
  seconds: round((snaps[snaps.length - 1].at - snaps[0].at) / 1000, 1),
  snapshots: snaps.length,
  arrivalMs: { median: round(percentile(arrival, .5)), p95: round(percentile(arrival, .95)), max: round(Math.max(...arrival)) },
  worldMs: { median: round(percentile(world, .5)), p95: round(percentile(world, .95)), max: round(Math.max(...world)), min: round(Math.min(...world)) },
  ticksBetween: { median: round(percentile(tk, .5), 2), min: Math.min(...tk), max: Math.max(...tk) },
  // 服务端/链路自己造成的长停：冻住的责任在这里，不在渲染头。
  longGaps: { count: longGaps.length, totalMs: Math.round(stallsMs), longestMs: Math.round(Math.max(0, ...longGaps)) },
  longGapsAtMs: stallAt,
  // 探针自己的心跳间隔：最大间隔远大于 40ms 就说明这个测量进程自己也卡过，
  // 上面那些"长停"要打折扣（它量的是"消息没被处理到"，不一定是"消息没到"）。
  probePumpGapMs: (() => {
    const g = [];
    for (let i = 1; i < pumpAt.length; i++) g.push(pumpAt[i] - pumpAt[i - 1]);
    return { count: g.length, median: round(percentile(g, .5)), p95: round(percentile(g, .95)), max: Math.round(Math.max(0, ...g)) };
  })(),
  renderFrames: frames,
  // 头部冻结帧的比例：就是"幻灯片"感的直接来源。
  frozenPct: round(frozen / frames * 100, 1),
  // 单帧位移超过 12px 的帧数：与 frozenPct 成对出现就是"卡住再猛跳"。
  bigSteps,
  // 被数据边缘按住的帧数（头跑到了最新一帧前面，只能等）/ 一次挪多半格（猛跳）的帧数。
  edgeHold, jumps,
  // 头离最新快照的世界时间有多远，正常应当稳定在插值延迟附近。
  headGapMs: { median: round(percentile(headGap, .5)), p95: round(percentile(headGap, .95)), min: round(Math.min(...headGap)) },
  perFramePx: { median: round(percentile(perFrameDelta, .5), 2), p95: round(percentile(perFrameDelta, .95), 2), max: round(Math.max(...perFrameDelta), 2) },
  perEntityPx: { median: round(percentile(steps, .5), 3), max: round(Math.max(...steps), 2), count: steps.length },
  // 单帧位移相对"该实体自己的中位速度"的比值：1.0 = 完全匀速，
  // 2.0 以上 = 肉眼可见的顿挫。这是幻灯片感最直接的量化。
  jitter: jitterOf(moving),
  // 渲染头本身的推进：理想是每帧恒定（1/60 秒）。变异系数逼近 0 就是匀速。
  headStep: headStepStats(headStep),
  // 同上，但剔掉"被数据边缘按住"的帧——那些帧是链路长停造成的，不该算在头部算法头上。
  headStepClean: headStepStats(headStepClean),
  // 调试用：前几帧里所有实体的原始坐标，确认"机器人到底动不动"。
  trace: process.env.PROBE_TRACE === "1" ? snaps.slice(0, 6).map(s => s.a.map(e => [e.i, e.k, Math.round(e.x), Math.round(e.y)])) : undefined,
  // 调试用：某一个实体前 40 帧的逐帧位移（px），看波动到底是什么形状。
  sampleSeries: process.env.PROBE_TRACE === "1" ? { id: ids[ids.length - 1], px: (perEntity.get(ids[ids.length - 1]) || []).slice(20, 60).map(v => round(v, 2)) } : undefined,
}, null, 2));
