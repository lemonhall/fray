/**
 * 人数上限的**口径**。
 *
 * 上限有两层：租户规则（这个租户允许开多大的局）和模式上限（3v3 就是 6 人）。
 * 生效值永远是两者取小。列表页、名册页、快速匹配三方必须都看**同一个数**，
 * 否则就会出现"列表说这桌还能坐，进去却被 room_full 弹出来"。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createRoomState, addMember, publicView, view, setConfig } from "../src/room-state.mjs";

const make = (patch = {}) => createRoomState({
  tenant: "neon", roomId: "CAP001", name: "容量测试", hostId: "g_0", hostName: "柠檬叔", ...patch,
});

test("租户规则比模式上限小时，对外报的是租户规则那个数", () => {
  // 热点争夺的模式上限是 6，但这个租户只允许 4 个真人。
  const state = make({ maxHumans: 4, maxBots: 4 });
  assert.equal(state.maxHumans, 4, "生效上限");
  assert.equal(publicView(state).capacity, 4, "目录里必须写生效上限");
  assert.equal(view(state, "g_0").capacity, 4, "名册里也必须是同一个数");
});

test("租户规则比模式上限大时，被模式上限压住", () => {
  const state = make({ maxHumans: 10, maxBots: 9 });
  assert.equal(publicView(state).capacity, 6, "3v3 最多 6 个人");
  assert.equal(view(state, "g_0").capacity, 6);
  setConfig(state, { mode: "survival" });
  assert.equal(publicView(state).capacity, 10, "混战才放得开 10 个人");
});

/**
 * 快速匹配挑房间用的就是 `humans < capacity`。这条断言把"目录里的容量"和
 * "addMember 真实收不收人"绑在一起——旧实现在这里会露出马脚：目录写 6、
 * 真实上限 4，于是第 5 个人被塞进一间进不去的房。
 */
test("快速匹配的判据与 addMember 的判据必须一致", () => {
  const state = make({ maxHumans: 4, maxBots: 4 });
  for (let i = 0; i < 4; i++) addMember(state, { playerId: `g_${i}`, name: `P${i}` });

  const summary = publicView(state);
  const quickMatchWouldPick = summary.humans < summary.capacity;
  const reallyAccepts = addMember(state, { playerId: "g_late", name: "迟到的" }).ok;
  assert.equal(quickMatchWouldPick, false, "满员的房间不该被快速匹配挑中");
  assert.equal(reallyAccepts, false, "真人上限就是 4");
  assert.equal(quickMatchWouldPick, reallyAccepts, "两边的判据必须给出同一个答案");
});

test("换模式之后上限跟着变，超编的房间必须能被看出来", () => {
  const state = make({ maxHumans: 10, maxBots: 9, mode: "survival" });
  for (let i = 0; i < 8; i++) addMember(state, { playerId: `g_${i}`, name: `P${i}` });
  assert.equal(publicView(state).capacity, 10);

  setConfig(state, { mode: "control" });
  const summary = publicView(state);
  assert.equal(summary.humans, 8);
  assert.equal(summary.capacity, 6);
  assert.ok(summary.humans > summary.capacity, "界面据此把开打按钮按住，并把话说清楚");
});

test("view 是纯函数：同一个 now 必须给出逐字节相同的结果", () => {
  const state = make({ maxHumans: 6 });
  addMember(state, { playerId: "g_0", name: "柠檬叔", now: 1000 });
  addMember(state, { playerId: "g_1", name: "朋友", now: 4000 });

  const first = view(state, "g_0", 20_000);
  const second = view(state, "g_0", 20_000);
  assert.deepEqual(first, second, "同样的输入必须得到同样的输出（旧实现偷读 Date.now，这里会抖）");
  assert.equal(first.members.find(m => m.id === "g_1").wait, 16_000, "磨蹭了 16 秒");
  assert.equal(first.members.find(m => m.id === "g_0").wait, 0, "房主没有'等待确认'这回事");

  const later = view(state, "g_0", 30_000);
  assert.equal(later.members.find(m => m.id === "g_1").wait, 26_000, "时间往前走，等待秒数跟着走");
});
