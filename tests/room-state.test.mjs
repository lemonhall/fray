/**
 * 房间权限与名册：这是全项目最该有测试的地方。
 *
 * 房间规则（谁能开局、谁能改人数、房主走了谁接手）写成纯函数，就是为了能用
 * 一堆断言把它钉死，而不是靠"起个 workerd 点两下试试"。
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  createRoomState, addMember, removeMember, isHost, setBots, setConfig,
  setMemberGadget, startCheck, rosterOf, view, publicView,
} from "../src/room-state.mjs";

const make = (patch = {}) => createRoomState({
  tenant: "neon", roomId: "ABC123", name: "测试房", hostId: "g_1", hostName: "柠檬叔", ...patch,
});

test("建房默认值来自模式表，人数上限被夹在模式允许范围内", () => {
  const state = make({ bots: 99, maxBots: 9 });
  assert.equal(state.mode, "control");
  assert.equal(state.maxHumans, 6);
  assert.equal(state.bots, 6, "3v3 的机器人上限就是 6");
  assert.equal(state.phase, "staging");

  const survival = make({ mode: "survival", bots: 99 });
  assert.equal(survival.maxHumans, 10);
  assert.equal(survival.bots, 9);
});

test("第一个进来的人自动成为房主，重复进入不会抢走房主", () => {
  const state = make({ hostId: "", hostName: "" });
  const first = addMember(state, { playerId: "g_1", name: "柠檬叔" });
  assert.equal(first.ok, true);
  assert.equal(isHost(state, "g_1"), true);

  addMember(state, { playerId: "g_2", name: "第二位" });
  assert.equal(isHost(state, "g_2"), false);

  const again = addMember(state, { playerId: "g_1", name: "柠檬叔2" });
  assert.equal(again.rejoined, true);
  assert.equal(state.members.length, 2);
  assert.equal(isHost(state, "g_1"), true);
});

test("房间满员时拒绝新人，但已经在房里的人可以重连", () => {
  const state = make();
  for (let i = 0; i < 6; i++) addMember(state, { playerId: `g_${i}`, name: `P${i}` });
  const rejected = addMember(state, { playerId: "g_late", name: "迟到的" });
  assert.deepEqual(rejected, { ok: false, error: "room_full" });
  assert.equal(addMember(state, { playerId: "g_0", name: "P0" }).ok, true);
});

test("房主离开后顺位交给最早进房的人", () => {
  const state = make({ hostId: "", hostName: "" });
  addMember(state, { playerId: "g_1", name: "A", now: 1 });
  addMember(state, { playerId: "g_2", name: "B", now: 2 });
  addMember(state, { playerId: "g_3", name: "C", now: 3 });
  assert.equal(removeMember(state, "g_1"), true);
  assert.equal(state.hostId, "g_2");
  assert.equal(removeMember(state, "g_none"), false);
});

test("改人数与改配置都受模式上限约束", () => {
  const state = make({ bots: 2 });
  assert.equal(setBots(state, 99), 6, "3v3 最多 6 个机器人");
  assert.equal(setBots(state, -4), 0);
  setConfig(state, { difficulty: 5 });
  assert.equal(state.difficulty, 2);
  setConfig(state, { mode: "survival" });
  assert.equal(state.mode, "survival");
  assert.equal(state.maxHumans, 10);
  assert.equal(state.maxBots, 9);
  assert.equal(setBots(state, 99), 9);
  setConfig(state, { mode: "control" });
  assert.equal(state.maxHumans, 6, "切回 3v3 时上限要跟着收回来，而不是一路取最小");
  assert.equal(state.bots, 6);
  setConfig(state, { name: "一二三四五六七八九十".repeat(3) });
  assert.equal(state.name.length, 24);
});

test("开局准入：至少两个人参战", () => {
  const state = make({ bots: 2 });
  assert.equal(startCheck(state).error, "no_players", "只有机器人不算一局对战");

  addMember(state, { playerId: "g_1", name: "A" });
  assert.deepEqual(startCheck(state), { ok: true, total: 3 });

  setBots(state, 0);
  assert.equal(startCheck(state).error, "need_two");
  setBots(state, 1);
  assert.deepEqual(startCheck(state), { ok: true, total: 2 });
});

test("名册把人变成实体，并带上各自选的战术装置", () => {
  const state = make();
  addMember(state, { playerId: "g_1", name: "A", hero: 2, gadget: "heal" });
  setMemberGadget(state, "g_1", "shield");
  assert.equal(setMemberGadget(state, "g_1", "不存在"), false);
  assert.equal(setMemberGadget(state, "g_none", "heal"), false);
  assert.deepEqual(rosterOf(state), [
    { kind: "human", ownerId: "g_1", name: "A", type: 2, gadget: "shield" },
  ]);
});

test("房间视图分成两版：给目录看的概括版、给玩家看的细节版", () => {
  const state = make();
  addMember(state, { playerId: "g_1", name: "A", hero: 1 });
  addMember(state, { playerId: "g_2", name: "B", hero: 3 });

  const summary = publicView(state);
  assert.equal(summary.id, "ABC123");
  assert.equal(summary.humans, 2);
  assert.equal(summary.capacity, 6);
  assert.equal(summary.host, "柠檬叔");
  assert.ok(!("members" in summary), "目录不需要看到每个人的细节");

  const mine = view(state, "g_2");
  assert.equal(mine.t, "room");
  assert.equal(mine.you.host, false);
  assert.equal(mine.members.find(m => m.id === "g_2").me, 1);
  assert.equal(mine.members.find(m => m.id === "g_2").g, "grenade");
  assert.equal(mine.capacity, 6);
});
