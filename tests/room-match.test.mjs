/**
 * 开、进、退：名册 → 场上实体，以及中途进出的人怎么落位。
 *
 * 这一层是"房间"和"世界"之间的缝，最容易被改坏却最难在浏览器里复现，
 * 所以它的每一条行为都在这里钉一遍。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createRoomState, addMember } from "../src/room-state.mjs";
import { beginMatch, resetMatch, joinLive, dropPlayer, actorIdOf, advanceWorld } from "../src/room-match.mjs";
import { MAX_CATCHUP_TICKS } from "../sim/constants.mjs";
import { pushCmd } from "../sim/netcode.mjs";

function staging(bots = 4, mode = "control") {
  const state = createRoomState({ tenant: "neon", roomId: "R1", name: "房", mode, bots, hostId: "g_1", hostName: "A" });
  addMember(state, { playerId: "g_1", name: "A", hero: 0, gadget: "grenade" });
  addMember(state, { playerId: "g_2", name: "B", hero: 2, gadget: "heal" });
  return state;
}

test("开局把名册变成场上的实体，两人分到对立两队", () => {
  const state = staging();
  const { world, mapMsg } = beginMatch(state, 1000);
  assert.equal(state.phase, "live");
  assert.equal(state.startedAt, 1000);
  assert.ok(state.lastSeed > 0);
  assert.equal(mapMsg.t, "map");
  assert.equal(world.actors.length, 6, "2 个真人 + 4 个机器人");

  const humans = world.actors.filter(a => a.kind === "human");
  assert.equal(humans.length, 2);
  assert.notEqual(humans[0].team, humans[1].team, "两个真人一定能对上枪");
  const b = humans.find(a => a.ownerId === "g_2");
  assert.equal(b.type, 2);
  assert.equal(b.gadget, "heal", "选的装置跟着人进场");
});

test("对局中有人进来：直接补一个实体，队伍往人少的一边放", () => {
  const state = staging(2);
  const { world } = beginMatch(state);
  addMember(state, { playerId: "g_3", name: "C", hero: 1 });
  const member = state.members.find(m => m.playerId === "g_3");
  const actor = joinLive(world, member);
  assert.ok(actor);
  assert.equal(actor.ownerId, "g_3");
  assert.equal(joinLive(world, member), null, "同一个人不会补两个实体");

  const counts = [0, 0];
  for (const a of world.actors) if (a.kind === "human") counts[a.team]++;
  assert.equal(Math.abs(counts[0] - counts[1]), 1);
});

test("掉线只清掉还没消化的输入命令，人不从场上消失", () => {
  const state = staging(2);
  const { world } = beginMatch(state);
  const actor = world.actors.find(a => a.ownerId === "g_1");
  pushCmd(actor, { sq: 1, mx: 1, my: 0, a: 0, f: 0, act: 0, r: 310, n: 4 }, 1000);
  assert.equal(actor.queued, 4, "命令入队");
  const id = actorIdOf(world, "g_1");
  dropPlayer(world, "g_1");
  assert.equal(actor.queued, 0, "人走了，欠下的那几格就不该再走");
  assert.equal(actor.cmds.length, 0);
  assert.ok(world.actors.some(a => a.ownerId === "g_1"), "实体还在原地挨打");
  assert.equal(actorIdOf(world, "不存在"), 0);
});

test("补算：跨境链路上常见的一秒级断流不该再丢时间", () => {
  const state = staging(2);
  const { world } = beginMatch(state);
  const step = 1000 / 60;
  // 1.5 秒没有任何消息到达（现实里就是一次 TCP 重传或者一次拥塞窗口）。
  const base = advanceWorld(world, 1_000_000, 1_000_000 + step * 90 + .5, MAX_CATCHUP_TICKS);
  assert.equal(world.tick, 90, "90 步全补上，一格不丢");
  assert.equal(base, 1_000_000 + step * 90);
});

test("重开一局：回到候场，场上清空", () => {
  const state = staging();
  const { world } = beginMatch(state);
  state.phase = "over";
  resetMatch(state, world);
  assert.equal(state.phase, "staging");
  assert.equal(state.results, null);
  assert.equal(world.actors.length, 0);
});

test("补算：按墙上时间推进，但超预算时丢掉积压而不是滚雪球", () => {
  const state = staging(4);
  const { world } = beginMatch(state);
  const step = 1000 / 60;
  let base = 1_000_000;
  // 多给半毫秒：`floor` 遇上二进制浮点会把"刚好 10 步"算成 9.999…，这是测试的坑，
  // 不是被测量的行为有问题——所以这里按真实的时钟抖动来喂它。
  base = advanceWorld(world, base, base + step * 10 + .5, 30);
  assert.equal(world.tick, 10);
  assert.equal(base, 1_000_000 + step * 10);

  const before = world.tick;
  const now = base + step * 5000;
  const next = advanceWorld(world, base, now, 30);
  assert.equal(world.tick - before, 30, "最多补 30 步");
  assert.equal(next, now, "超预算就对齐到现在，不留下时间债");
  assert.equal(advanceWorld(world, next, next), next, "时间没走就不推进");
});
