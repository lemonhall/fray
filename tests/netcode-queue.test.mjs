/**
 * 输入命令队列的语义钉子。
 *
 * 这几条不变式一旦松掉，表现就是"人走得好好的忽然被拽回去"或者"角色自己往前走"——
 * 全是那种在浏览器里极难复现、但在这里三行就能钉死的东西。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { pushCmd, takeCmd, settleAck, resetQueue, queuedTicks, MAX_QUEUED_TICKS } from "../sim/netcode.mjs";

const cmd = (over = {}) => ({ sq: 1, mx: 1, my: 0, a: 0, f: 0, act: 0, r: 310, n: 3, ...over });

test("一格一格地消化：命令走完才算 ack，ack 坐标是走完那一刻的位置", () => {
  const a = { x: 100, y: 100 };
  resetQueue(a);
  pushCmd(a, cmd({ n: 3 }), 0);
  assert.equal(queuedTicks(a), 3);

  const first = takeCmd(a);
  assert.deepEqual([first.mx, first.my, first.act], [1, 0, 0]);
  a.x += 4; settleAck(a);
  assert.equal(a.ack, 0, "只走了一格：还没确认");
  assert.equal(queuedTicks(a), 2);

  takeCmd(a); a.x += 4; settleAck(a);
  takeCmd(a); a.x += 4; settleAck(a);
  assert.equal(a.ack, 1, "三格走完 → 确认");
  assert.equal(a.ackX, 112, "确认点是那一刻的坐标，不是现在的坐标");
  assert.equal(queuedTicks(a), 0);
  assert.equal(takeCmd(a), null, "队列空了就站着不动（掉线的人不会自己跑）");
});

test("一次性动作只在命令的第一格触发", () => {
  const a = { x: 0, y: 0 };
  resetQueue(a);
  pushCmd(a, cmd({ n: 2, act: 1 }), 0);
  assert.equal(takeCmd(a).act, 1, "第一格带上动作");
  assert.equal(takeCmd(a).act, 0, "第二格不能重复触发——否则按一次闪避会闪两下");
});

test("队列超预算丢最老的命令：移速上限靠这一条守住", () => {
  const a = { x: 0, y: 0 };
  resetQueue(a);
  for (let i = 1; i <= 40; i++) pushCmd(a, cmd({ sq: i, n: 20 }), i);
  assert.ok(queuedTicks(a) <= MAX_QUEUED_TICKS, `队列 ${queuedTicks(a)} ≤ 预算 ${MAX_QUEUED_TICKS}`);
  assert.ok(a.ack > 0, "丢掉的那几段直接算确认——它们不会再被走");
  // 声明 800 格却只能留下不到 150 格：这就是"客户端吹牛"能拿到的上限（真实时间）。
  assert.ok(queuedTicks(a) > MAX_QUEUED_TICKS - 20, `预算被封在 ${MAX_QUEUED_TICKS} 附近`);
});

test("n=0 的命令不入队，只负责让世界别停", () => {
  const a = { x: 0, y: 0 };
  resetQueue(a);
  pushCmd(a, cmd({ n: 0, act: 4 }), 0);
  assert.equal(queuedTicks(a), 0);
  assert.equal(takeCmd(a), null);
  assert.equal(a.lastCmdAt, 0, "调用方给的时钟要原样记下来（老客户端的格数折算靠它）");
});

test("resetQueue 把队列和确认点一起归零", () => {
  const a = { x: 33, y: 44 };
  resetQueue(a);
  pushCmd(a, cmd({ n: 5 }), 10);
  takeCmd(a);
  resetQueue(a);
  assert.deepEqual(
    [a.cmds.length, a.queued, a.ack, a.ackX, a.ackY],
    [0, 0, 0, 33, 44],
  );
});
