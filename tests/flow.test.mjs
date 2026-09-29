/**
 * 对局流程：挑战项、奖励、以及"什么时候算打完"。
 *
 * 这些数字最后会显示在结算页上，也会写进 D1 的排行榜，所以它们必须是纯函数、
 * 可断言、且只依赖世界对象——不能"看起来大概对"。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createWorld, startMatch, fillRoster } from "../sim/world.mjs";
import { contractsOf, rewardOf, endMatch, checkSurvivalEnd } from "../sim/flow.mjs";

function world(mode = "control", bots = 5) {
  const w = createWorld({ tenant: "neon", roomId: "T9", mode, difficulty: 1, seed: 777 });
  startMatch(w, fillRoster(w, [
    { kind: "human", ownerId: "g_1", name: "我", type: 0 },
  ], bots), 777);
  return w;
}

test("挑战项跟着模式换：占点局看占点时长，混战看总伤害", () => {
  const control = world("control", 1);
  const rows = contractsOf(control, control.actors[0]);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].name, "淘汰对手");
  assert.equal(rows[2].name, "累计占点");
  assert.equal(rows[2].suffix, "s");

  const survival = world("survival", 1);
  assert.equal(contractsOf(survival, survival.actors[0])[2].name, "对敌人造成伤害");
  assert.equal(contractsOf(survival, null).length, 0);
});

test("奖励随击杀、等级、名次与完成的挑战一起涨", () => {
  const w = world("control", 1);
  const a = w.actors[0];
  const base = rewardOf(w, a, 2);
  a.kills = 4;
  assert.ok(rewardOf(w, a, 2) > base);
  assert.equal(rewardOf(w, a, 1) - rewardOf(w, a, 2), 100, "冠军有 100 点额外奖励");
  a.collected = 3; a.captureTime = 20; a.level = 3;
  assert.ok(rewardOf(w, a, 1) >= base + 100 + 4 * 25 + 2 * 60);
});

test("占点局收局：按比分定胜负，每个人的名次是队名而不是数字", () => {
  const w = world("control");
  w.score = [100, 42];
  w.time = 123;
  endMatch(w);
  assert.equal(w.phase, "over");
  assert.equal(w.results.kind, "control");
  assert.equal(w.results.winnerTeam, 0);
  assert.equal(w.results.duration, "02:03");
  assert.equal(w.results.players.length, w.actors.length);
  for (const player of w.results.players) {
    assert.ok(player.rank === 1 || player.rank === 2);
    assert.equal(player.rank, player.team === 0 ? 1 : 2);
    assert.ok(player.reward >= 100);
  }
});

test("混战收局：最后活着的人第一，其余按剩余生命排", () => {
  const w = world("survival");
  w.time = 300;
  w.actors.forEach((a, i) => { a.alive = i === 3; a.hp = 100 + i; });
  assert.equal(checkSurvivalEnd(w), true);
  assert.equal(w.results.kind, "survival");
  assert.equal(w.results.winnerActorId, w.actors[3].id);
  const winner = w.results.players.find(p => p.rank === 1);
  assert.equal(winner.actorId, w.actors[3].id);

  const fresh = world("survival");
  fresh.actors.forEach(a => { a.alive = true; });
  assert.equal(checkSurvivalEnd(fresh), false, "人还没死光就不能收局");
});
