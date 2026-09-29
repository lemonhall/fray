/**
 * 开、进、退：名册 → 场上实体，以及中途进出的人怎么落位。
 *
 * 这一层是"房间"和"世界"之间的缝，最容易被改坏却最难在浏览器里复现，
 * 所以它的每一条行为都在这里钉一遍。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createRoomState, addMember } from "../src/room-state.mjs";
import { beginMatch, resetMatch, joinLive, dropPlayer, actorIdOf, advanceWorld, beatGrid } from "../src/room-match.mjs";
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
  const now = 1_000_000 + step * 90 + .5;
  assert.equal(advanceWorld(world, 1_000_000, now, MAX_CATCHUP_TICKS), now);
  assert.equal(world.tick, 90, "90 步全补上，一格不丢");
  // 那半毫秒的零头没被扔掉，它记账在 stepCarry 里，下一次补算会补上。
  assert.ok(world.stepCarry > 0 && world.stepCarry < step, "不足一格的零头记账，不丢时间");
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

test("补算：超预算时削掉这一次的欠账，绝不让世界滚雪球", () => {
  const state = staging(4);
  const { world } = beginMatch(state);
  const step = 1000 / 60;
  let base = 1_000_000;
  // 喂给它一个"差半毫秒不到整格"的时刻——真实时钟就是这样抖的。
  // 推进的记账基准是墙上时间，所以返回值就是喂进去的那个时刻本身。
  const early = base + step * 10 + .5;
  assert.equal(advanceWorld(world, base, early, 30), early);
  base = early;
  assert.equal(world.tick, 10);

  const before = world.tick;
  const now = base + step * 5000;
  const next = advanceWorld(world, base, now, 30);
  assert.equal(world.tick - before, 30, "最多补 30 步");
  assert.equal(next, now, "推进的记账基准永远是墙上时间");
  assert.equal(advanceWorld(world, next, next), next, "时间没走就不推进");
});

/**
 * "幻灯片"那个 bug 的出生地就在这条测试里。
 *
 * 世界是**按消息到达驱动**的，消息的间隔永远不会正好是 16.67ms。老实现每次只走
 * `floor(经过时间 / 16.67)` 步、把零头扔掉，于是世界的平均速度比真实时间慢一大截；
 * 客户端的渲染头按真实时间走，就会一会儿追过数据（只能冻住等）、一会儿被新快照
 * 拽回去——画面上就是幻灯片。
 *
 * 所以这里喂一串**故意恶心**的间隔（不整除、还带抖动），要求世界的累计时间必须
 * 跟上墙上时间；同时要求任何一次补算都守得住 `maxTicks`，不会把 CPU 打满。
 */
test("补算：把不整格的零头记账，世界的平均速度和墙上时间一致", () => {
  const state = staging(0);
  const { world } = beginMatch(state);
  const step = 1000 / 60;
  let now = 5_000_000;
  const start = now;
  // 25Hz 上行的真实形状：间隔 37~43ms，还夹两次 300ms 的卡顿。
  const gaps = [41, 39, 40, 300, 37, 43, 38, 42, 300, 40];
  for (let round = 0; round < 12; round++) {
    for (const gap of gaps) {
      now += gap;
      advanceWorld(world, now - gap, now, MAX_CATCHUP_TICKS);
    }
  }
  const wallSeconds = (now - start) / 1000;
  // 记账天然是离散的：世界时间最多落后一格（攒在 stepCarry 里的零头），
  // 但绝不允许"慢了百分之十几"这种系统性丢失——那正是幻灯片感的来源。
  const lagMs = (wallSeconds - world.time) * 1000;
  assert.ok(lagMs >= -0.01 && lagMs < step * 1.5,
    `世界时间 ${world.time.toFixed(3)}s 比墙上时间 ${wallSeconds.toFixed(3)}s 慢了 ${lagMs.toFixed(1)}ms`);
});

/**
 * 节拍网格（`beatGrid`）——第二把"幻灯片"的钥匙。
 *
 * 世界推进的时刻必须取**网格上该到的时刻**，不能取计时器实际醒来的时刻。workerd 的
 * `setTimeout(50)` 实测平均 62ms 才醒；拿实际时刻推进，世界就比广播快 1.2 倍，客户端
 * 的插值头只能一路追赶。这里把那段算术钉死：不管计时器晚多少，世界都按 50ms 的整数格
 * 走，而且**永远不会被排在"未来"**（那会让世界跑到墙上时间前面去）。
 */
test("节拍网格：计时器晚醒不改世界的步伐，长停只丢快照不丢时间", () => {
  const first = beatGrid({ now: 1_000_000, nextBcastMs: 0 });
  assert.deepEqual(first, { target: 1_000_000, next: 1_000_050, skipped: 0, started: true });
  assert.equal(beatGrid({ now: 1_000_020, nextBcastMs: first.next }), null, "没到点就该什么都不做");

  // 计时器晚了 12ms 才醒：世界仍然只推进到网格上的那一格。
  const late = beatGrid({ now: 1_000_062, nextBcastMs: first.next });
  assert.equal(late.target, 1_000_050);
  assert.equal(late.next, 1_000_100);
  assert.equal(late.skipped, 0);

  // 连续 20 拍都晚 12ms 醒：世界的时刻永远落在网格上（原点 + N×50ms），
  // 永远不超前于墙上时间，而且最多只落后一格——攒够一格就把整格跳过去（skipped）。
  let nextBcastMs = first.next, now = 1_000_000;
  for (let i = 0; i < 20; i++) {
    now += 62;
    const grid = beatGrid({ now, nextBcastMs });
    nextBcastMs = grid.next;
    assert.equal((grid.target - first.target) % 50, 0, "世界时刻永远落在 50ms 的网格上");
    assert.ok(grid.target <= now, "世界永远不推进到未来");
    assert.ok(now - grid.target < 50, "最多落后一格：攒够了就跳过去，不欠账");
  }
  assert.equal(now - nextBcastMs < 50, true, "网格自己不能漂");

  // DO 被冻了 900ms：一次补上时间，但只发一张快照（skipped 记下跳过了几格）。
  const stall = beatGrid({ now: nextBcastMs + 900, nextBcastMs });
  assert.equal(stall.skipped, 18);
  assert.equal(stall.target, nextBcastMs + 900 - ((nextBcastMs + 900 - nextBcastMs) % 50));
  assert.equal(stall.next - stall.target, 50);
});
