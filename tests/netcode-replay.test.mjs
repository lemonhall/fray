/**
 * 延迟链路对拍：真实的客户端模块（`web/js/predict.mjs` + `web/js/cmd.mjs`）隔着一段
 * **会抖、会堵**的链路和权威端跑几秒，然后量两件事：
 *
 *   1. 本机显示的位置有没有往后退过——用户说的"往前走了一段又跳回一小段"；
 *   2. 本机显示的位置有没有偏离"从出生点重放全部命令"那条理想轨迹。
 *
 * 为什么值得写这么一条测试：本地 localhost 上这个数字永远是 0，手感 bug 只在
 * 真实延迟下才出生。把"链路"做成可编程的，它才有一个能自动化复现的出生地。
 *
 * 顺带还跑一个**对照组**：同样一条链路、同样一段输入，只把对账规则换回旧版
 * （拿最新快照的坐标和本机预测硬比）。它每次都会被拽回去几十上百像素——
 * 这条对照说明测试确实看得见当年那个 bug，而不是恰好断言在一个死数字上。
 *
 * 断言的口径是"没有**看得见**的回退"，不是"数学上一步都不许退"：两端方向量化成
 * 1/16、每格位移又乘 dt，最后几位小数的舍入差会让个别帧退到 0.0x 像素（一像素的
 * 几十分之一，屏幕上不存在）。真正要按住的是旧规则那种几十上百像素的整段回跳，
 * 所以判据是"最大单帧回退 < 1px"，对照组则必须 > 30px——两头都钉住，断言才不会退化。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { DT, TICK_HZ, TILE, GRID, MAX_CATCHUP_TICKS } from "../sim/constants.mjs";
import { MAX_CMD_TICKS, pushCmd, queuedTicks, resetQueue } from "../sim/netcode.mjs";
import { replayFrom, pendingTicks } from "../sim/replay.mjs";
import { applyMove } from "../sim/input.mjs";
import { encodeSnapshot, decodeMap } from "../sim/wire.mjs";
import { heroOf } from "../sim/data.mjs";
import { beginMatch, advanceWorld } from "../src/room-match.mjs";
import { createRoomState, addMember } from "../src/room-state.mjs";
import { BROADCAST_MS } from "../src/room-consts.mjs";
import { S } from "../web/js/state.mjs";
import { initPredict, stepPredict, reconcile } from "../web/js/predict.mjs";
import { initCmds, frameDir, noteTick, flushCmd } from "../web/js/cmd.mjs";

const OWNER = "g_1";
const step = 1000 / TICK_HZ;

/** 链路模型：基线 90ms + 每包 0~35ms 排队抖动；`stalls` 窗口内到达的包压到窗口末尾一起发。 */
const link = stalls => at => {
  let lat = 90 + 35 * Math.abs(Math.sin(at / 137));
  for (const [from, to] of stalls) if (at >= from && at < to) lat = Math.max(lat, to - at);
  return at + lat;
};

/** 挑一条真的走得动的方向：撞墙的探针测不出手感，只会测出"卡在墙上"。 */
function pickDir(w, x, y) {
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    let clear = true;
    for (let d = 1; d <= 4 && clear; d++) {
      const tx = Math.floor((x + dx * d * TILE) / TILE), ty = Math.floor((y + dy * d * TILE) / TILE);
      const v = tx < 1 || ty < 1 || tx > GRID - 2 || ty > GRID - 2 ? 1 : w.grid[ty * GRID + tx];
      if (v === 1 || v === 2) clear = false;
    }
    if (clear) return { x: dx, y: dy };
  }
  return { x: 1, y: 0 };
}

function runLink({ durationMs = 6000, stalls = [] } = {}) {
  const deliverAt = link(stalls);
  const state = createRoomState({
    tenant: "neon", roomId: "N1", name: "链路", mode: "control", bots: 0, hostId: OWNER, hostName: "A",
  });
  addMember(state, { playerId: OWNER, name: "A", hero: 0, gadget: "grenade" });
  addMember(state, { playerId: "g_2", name: "B", hero: 1, gadget: "heal" });
  const { world, mapMsg } = beginMatch(state, 0);
  const actor = world.actors.find(a => a.ownerId === OWNER);
  const speed = heroOf(actor.type).speed;

  resetQueue(actor);
  const mine0 = encodeSnapshot(world, actor.id).a.find(a => a.ow === OWNER);
  initPredict(S, decodeMap(mapMsg), mine0);
  S.actions = 0;

  // 参考轨迹：和客户端同一份地形，但从出生点重放**全部**命令——它是"没有延迟时
  // 本机应当走出来的那条路"。客户端画面必须一直贴着它。
  const refW = { ...S.predictW };
  const refA = { ...S.predictMe };
  // 对照组：同样的输入、同样的地形，只把对账规则换回旧版。
  const legW = { ...S.predictW };
  const legA = { ...S.predictMe };
  legA.x = actor.x; legA.y = actor.y;

  const dir = pickDir(refW, actor.x, actor.y);
  const history = [];
  const inflight = [], snaps = [];
  let outbox = [];
  initCmds(payload => outbox.push(payload));

  let acc = 0, last = 0, lastTickMs = 0, lastBroadcastMs = -Infinity, now = 0;
  let prevX = S.predictMe.x, prevY = S.predictMe.y, prevLX = legA.x, prevLY = legA.y;
  const m = { frames: 0, backFrames: 0, maxBack: 0, maxIdealErr: 0, maxLeadSlack: -Infinity, legacyMaxBack: 0, moved: 0 };

  for (let i = 1; i * step <= durationMs; i++) {
    now = i * step;

    // 1) 上行到点：进队列、推进权威世界、按节流窗口发快照（全部按"到达时刻"算）。
    while (inflight.length && inflight[0].at <= now) {
      const item = inflight.shift();
      pushCmd(actor, { ...item.p, n: Math.min(MAX_CMD_TICKS, item.p.n) }, item.at);
      lastTickMs = advanceWorld(world, lastTickMs, item.at, MAX_CATCHUP_TICKS);
      if (item.at - lastBroadcastMs >= BROADCAST_MS) {
        lastBroadcastMs = item.at;
        snaps.push({ at: deliverAt(item.at), snap: encodeSnapshot(world, actor.id) });
        snaps.sort((a, b) => a.at - b.at);
      }
    }

    // 2) 下行到点：两边各自对账（新规则 vs 旧规则）。
    while (snaps.length && snaps[0].at <= now) {
      const mine = snaps.shift().snap.a.find(a => a.ow === OWNER);
      reconcile(S, mine);
      const dx = mine.x - legA.x, dy = mine.y - legA.y;
      if (Math.hypot(dx, dy) > 70) { legA.x = mine.x; legA.y = mine.y; }
      else { legA.x += dx * .22; legA.y += dy * .22; }
    }

    // 3) 客户端跑一帧：预测自己、攒命令、40ms 一发。
    const flags = { k: 0, f: 0, r: 310 };
    const cmd = frameDir(now, dir.x, dir.y, 0, flags);
    acc += (now - last) / 1000; last = now;
    let guard = 0;
    while (acc >= DT && guard++ < 24) {
      stepPredict(S, DT, cmd.mx, cmd.my, cmd.a);
      noteTick(cmd);
      applyMove(legW, legA, cmd.mx, cmd.my, DT);
      acc -= DT;
    }
    if (acc > DT * 2) acc = DT * 2;
    flushCmd(now, flags);
    for (const p of outbox) {
      history.push({ sq: p.sq, mx: p.mx, my: p.my, n: p.n });
      inflight.push({ at: deliverAt(now), p });
      inflight.sort((a, b) => a.at - b.at);
    }
    outbox.length = 0;

    // 4) 量数据。
    const me = S.predictMe;
    m.maxBack = Math.max(m.maxBack, -(me.x - prevX) * dir.x - (me.y - prevY) * dir.y);
    m.legacyMaxBack = Math.max(m.legacyMaxBack, -(legA.x - prevLX) * dir.x - (legA.y - prevLY) * dir.y);
    if ((me.x - prevX) * dir.x + (me.y - prevY) * dir.y < 0) m.backFrames++;
    prevX = me.x; prevY = me.y; prevLX = legA.x; prevLY = legA.y;

    // 参考轨迹 = 出生点 + 全部已声明命令（含正在走、还没发出去的那一条）。
    const declared = S.cmd && S.cmd.n > 0 ? [...history, S.cmd] : history;
    replayFrom(refW, refA, declared, actor.spawnX, actor.spawnY);
    const idealErr = Math.hypot(me.x - refA.x, me.y - refA.y);
    if (process.env.NETCODE_DEBUG && idealErr > m.maxIdealErr) {
      console.log(`[dbg] t=${now.toFixed(0)} ack=${me.ak} spare=${S.cmds.length} pending=${pendingTicks(S.cmds)} ` +
        `queued=${queuedTicks(actor)} target=(${me.ax},${me.ay}) me=(${me.x.toFixed(1)},${me.y.toFixed(1)}) ` +
        `ideal=(${refA.x.toFixed(1)},${refA.y.toFixed(1)}) err=${idealErr.toFixed(2)}`);
    }
    m.maxIdealErr = Math.max(m.maxIdealErr, idealErr);
    const lead = Math.hypot(me.x - actor.x, me.y - actor.y);
    m.maxLeadSlack = Math.max(m.maxLeadSlack, lead - (pendingTicks(S.cmds) + queuedTicks(actor)) * speed * DT - 24);
    m.frames++;
  }
  m.moved = Math.hypot(S.predictMe.x - actor.spawnX, S.predictMe.y - actor.spawnY);
  return m;
}

const round = (v, n = 1) => `${v.toFixed(n)}px`;

test("抖动链路（单向 90~125ms）：本地画面一帧都不往后退", () => {
  const m = runLink({ durationMs: 6000 });
  assert.ok(m.moved > 200, `这条测试要有意义，先得真的走动：${round(m.moved)}`);
  assert.ok(m.maxIdealErr < 1.5, `本机画面偏离了理想轨迹 ${round(m.maxIdealErr, 2)}`);
  assert.ok(m.maxBack < 1, `${m.backFrames} 帧在往回走，最大一步 ${round(m.maxBack, 3)}——这是看得见的回退`);
});

test("链路堵 0.7 秒再放行：世界丢时间，也不该把人拽回去", () => {
  const m = runLink({ durationMs: 7000, stalls: [[1500, 2200], [4200, 4900]] });
  assert.ok(m.moved > 200, `先得真的走动：${round(m.moved)}`);
  // 旧规则在这条链路上一定会拽人，而且幅度是几十到几百像素——这就是对照组的意义。
  assert.ok(m.legacyMaxBack > 30, `对照组的旧规则应当被拽回去，实测最大 ${round(m.legacyMaxBack)}`);
  // 新规则：不后退、不跑偏、领先量始终不超过"还没被消化的那几格"。
  assert.ok(m.maxBack < 1, `${m.backFrames} 帧在往回走，最大一步 ${round(m.maxBack, 3)}——这是看得见的回退`);
  assert.ok(m.maxIdealErr < 1.5, `本机画面偏离了理想轨迹 ${round(m.maxIdealErr, 2)}`);
  assert.ok(m.maxLeadSlack <= 0, `画面比权威端领先太多：超出未确认格数 ${round(m.maxLeadSlack)}`);
});

test("长断流（2.5 秒没有消息）：恢复后依然是平滑的", () => {
  const m = runLink({ durationMs: 9000, stalls: [[3000, 5500]] });
  assert.ok(m.maxBack < 1, `${m.backFrames} 帧在往回走，最大一步 ${round(m.maxBack, 3)}——这是看得见的回退`);
  assert.ok(m.maxIdealErr < 1.5, `本机画面偏离了理想轨迹 ${round(m.maxIdealErr, 2)}`);
});
