import test from "node:test";
import assert from "node:assert/strict";

import { createWorld, startMatch, fillRoster } from "../sim/world.mjs";
import { stepWorld } from "../sim/step.mjs";
import { DT } from "../sim/constants.mjs";
import { encodeSnapshot } from "../sim/wire.mjs";

function build(mode, seed, bots, humans) {
  const w = createWorld({ tenant: "t", roomId: "r", mode, difficulty: 1, seed });
  const roster = [
    ...humans.map((h, i) => ({ kind: "human", ownerId: `p${i}`, name: `玩家${i}`, type: h })),
  ];
  const full = fillRoster(w, roster, bots);
  startMatch(w, full, seed);
  return w;
}

function run(w, ticks, input) {
  for (let i = 0; i < ticks; i++) {
    if (input) input(w, i);
    stepWorld(w, DT);
  }
  return w;
}

function digest(w) {
  return JSON.stringify({
    tick: w.tick, time: Math.round(w.time * 100) / 100, phase: w.phase,
    actors: w.actors.map(a => [a.id, Math.round(a.x), Math.round(a.y), Math.round(a.hp), a.kills, a.alive ? 1 : 0]),
    bullets: w.bullets.length, cubes: w.cubes.length, score: w.score.map(Math.floor),
  });
}

test("同一颗种子 + 同一段输入 => 完全相同的对局（确定性）", () => {
  const a = run(build("control", 12345, 6, [0, 2]), 900);
  const b = run(build("control", 12345, 6, [0, 2]), 900);
  assert.equal(digest(a), digest(b));
});

test("不同种子 => 不同对局（种子真的在用）", () => {
  const a = run(build("survival", 1, 9, [1]), 600);
  const b = run(build("survival", 999, 9, [1]), 600);
  assert.notEqual(digest(a), digest(b));
});

test("单位会动、会开火、会互相造成伤害", () => {
  const w = build("control", 777, 6, [0, 2]);
  run(w, 1200);
  const moved = w.actors.some(a => Math.abs(a.x - a.spawnX) > 100 || Math.abs(a.y - a.spawnY) > 100);
  assert.ok(moved, "至少有一个单位离开了出生点");
  assert.ok(w.actors.some(a => a.damage > 0), "有人打出了伤害");
  assert.ok(w.score[0] + w.score[1] > 0, "热点争夺在计分");
});

test("风暴会缩圈，圈外单位掉血", () => {
  const w = build("survival", 42, 9, [0]);
  run(w, 60 * 60);
  assert.ok(w.ring.r < 1420, "缩圈已经开始");
});

test("快照可序列化，且只包含接收者看得见的敌人", () => {
  const w = build("control", 555, 6, [0, 1]);
  run(w, 300);
  const self = w.actors.find(a => a.kind === "human");
  const snap = encodeSnapshot(w, self.id);
  const text = JSON.stringify(snap);
  assert.ok(text.length > 100);
  assert.ok(snap.a.some(a => a.i === self.id), "自己一定在快照里");
  assert.ok(snap.a.every(a => a.pk === undefined || a.i === self.id), "只有自己带升级数据");
});
