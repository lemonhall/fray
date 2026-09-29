/**
 * 节拍器：房间的时钟。
 *
 * 它能在 Node 里测，是因为它不碰 socket、不碰存储——只吃"现在几点"、吐"世界推进到
 * 哪一刻、该广播了"。这不是巧合，是刻意的分层：时间对齐的算术和 Durable Object 的
 * 生命周期搅在一起，就成了只能在线上调试的东西（这个 bug 就是这么来的）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { MatchTicker } from "../src/room-ticker.mjs";
import { createRoomState, addMember } from "../src/room-state.mjs";
import { beginMatch } from "../src/room-match.mjs";

/** 一个真开着的对局：跟 `room-match.test.mjs` 用的是同一条入口。 */
function liveWorld() {
  const state = createRoomState({ tenant: "neon", roomId: "R1", name: "房", mode: "control", bots: 4, hostId: "g_1", hostName: "A" });
  addMember(state, { playerId: "g_1", name: "A", hero: 0, gadget: "grenade" });
  addMember(state, { playerId: "g_2", name: "B", hero: 2, gadget: "heal" });
  return beginMatch(state, 1000).world;
}

/** 一个能手动控制时间的节拍器：把 setTimeout 换成一台"由测试来推"的钟。 */
function harness() {
  const frames = [], ends = [];
  const ticker = new MatchTicker({
    onFrame: now => frames.push({ now, time: world.time, tick: world.tick }),
    onEnd: () => ends.push(Date.now()),
  });
  const world = liveWorld();
  ticker.schedule = () => {};         // 不让它自己定时，测试手动 beat()
  return { ticker, frames, ends, world };
}

test("每一拍世界只推进网格上的一格，计时器晚醒也不改步伐", () => {
  const { ticker, frames, world } = harness();
  const t0 = 1_000_000;
  ticker.start(world, t0);
  assert.equal(frames.length, 0, "开局不动手，等第一拍");

  // workerd 的计时器平均晚 12ms 才醒：世界也必须只走 50ms。
  ticker.beat(t0 + 62);
  ticker.beat(t0 + 124);
  ticker.beat(t0 + 186);
  assert.equal(frames.length, 3);
  for (const f of frames) {
    assert.ok(Math.abs(f.time - 0.05 * (frames.indexOf(f) + 1)) < 1e-9,
      `第 ${frames.indexOf(f) + 1} 拍的世界时间应当是 ${0.05 * (frames.indexOf(f) + 1)}s，实际 ${f.time}`);
  }
  assert.equal(world.tick, 9, "每拍 3 格（50ms / 16.67ms）");
});

test("没到网格上的点就什么都不做，连着问也不会多推世界", () => {
  const { ticker, frames, world } = harness();
  const t0 = 1_000_000;
  ticker.start(world, t0);
  ticker.beat(t0 + 40);                 // 25Hz 上行落在窗口里：丢掉
  ticker.beat(t0 + 45);
  ticker.beat(t0 + 49);
  assert.equal(frames.length, 0);
  assert.equal(world.time, 0);
  ticker.beat(t0 + 50);                 // 到点
  assert.equal(frames.length, 1);
});

test("DO 被冻了 900ms：只丢快照，不丢世界时间", () => {
  const { ticker, frames, world } = harness();
  const t0 = 1_000_000;
  ticker.start(world, t0);
  ticker.beat(t0 + 50);
  const after = world.time;
  ticker.beat(t0 + 950);                // 一次长停
  assert.equal(frames.length, 2, "长停之后只补发一张快照");
  // 世界必须补到网格上（900ms 里 18 格被跳过，时间不能丢）。
  assert.ok(world.time - after > 0.85, `世界应当补上这 900ms，实际只走了 ${(world.time - after).toFixed(3)}s`);
  assert.ok(world.time <= 0.95 + 1e-9, "也不能跑到墙上时间前面去");
});

test("世界结束后停表，并回调通知房间去结算", () => {
  const { ticker, ends, world } = harness();
  const t0 = 1_000_000;
  ticker.start(world, t0);
  world.phase = "over";
  assert.equal(ticker.beat(t0 + 60), false);
  assert.equal(ends.length, 1, "必须通知房间");
  assert.equal(ticker.world, null, "停表之后不再持有世界");
});
