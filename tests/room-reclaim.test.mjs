/**
 * 房间回收的判据。
 *
 * 这里钉的是一条"破坏性操作"的边界，所以每一条断言都对应一个真实会出事的场景：
 * 打到一半的房间被回收（名册清空、世界扔掉）、连着却没人说话的僵尸连接、
 * 以及"名册没动过"这件事**不能**当成回收理由。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { reclaimReason, beginMatch, advanceWorld } from "../src/room-match.mjs";
import { createRoomState, addMember, setReady } from "../src/room-state.mjs";

const T0 = 1_700_000_000_000;
const MINUTE = 60_000;

test("没有连接 = 房间空了，必须回收", () => {
  assert.equal(reclaimReason({ conns: 0, lastMsgMs: T0, now: T0 + 1, idleMs: 30 * MINUTE }), "empty");
});

test("还有连接、消息也新鲜 = 不许回收", () => {
  assert.equal(reclaimReason({ conns: 3, lastMsgMs: T0, now: T0 + 1000, idleMs: 30 * MINUTE }), "");
});

test("连着但整整半小时一条消息都没有 = 僵尸连接，回收", () => {
  const idle = 30 * MINUTE;
  assert.equal(reclaimReason({ conns: 2, lastMsgMs: T0, now: T0 + idle + 1, idleMs: idle }), "silent");
  assert.equal(reclaimReason({ conns: 2, lastMsgMs: T0, now: T0 + idle, idleMs: idle }), "", "刚好卡在边界上不回收");
});

test("从没收到过消息的连接（lastMsgMs 为 0）不当作僵尸", () => {
  assert.equal(reclaimReason({ conns: 1, lastMsgMs: 0, now: T0 + 10 * MINUTE, idleMs: 30 * MINUTE }), "");
});

/**
 * 这条是回归测试：旧实现用 `state.updatedAt`（名册最后变动时间）判"房间死了"，
 * 而一局从头打到尾名册一次都不动——于是第 10 分钟 alarm 会把正在进行的对局拆掉
 * （名册清空、world 置空），玩家还连着，游戏却没了。
 */
test("打满 12 分钟的对局：名册时间戳完全没动，但房间绝不能被回收", () => {
  let now = T0;
  const state = createRoomState({
    tenant: "neon", roomId: "LONG12", name: "长局", bots: 4, now,
    hostId: "g_0", hostName: "柠檬叔",
  });
  addMember(state, { playerId: "g_0", name: "柠檬叔", now });
  addMember(state, { playerId: "g_1", name: "朋友", now });
  setReady(state, "g_1", true, now);
  const { world } = beginMatch(state, now);

  // 12 分钟：每 50ms 推一次世界，就像真实的 20Hz 心跳。
  let lastTickMs = now;
  for (let i = 0; i < 12 * 60 * 20; i++) {
    now += 50;
    lastTickMs = advanceWorld(world, lastTickMs, now, 240);
  }

  assert.equal(state.updatedAt - T0, 0, "名册从头到尾没动过——这正是旧判据会误判的原因");
  assert.ok(now - state.updatedAt > 10 * MINUTE, "旧判据（名册 > 10 分钟没动）此刻会判它该死");

  // 新判据：两个客户端一直在上行（输入 + 2 秒一次的心跳），房间绝对不许回收。
  assert.equal(reclaimReason({ conns: 2, lastMsgMs: now, now, idleMs: 30 * MINUTE }), "");
  assert.equal(world.phase, "over", "这局自己在 180 秒上按时收场了");
});
