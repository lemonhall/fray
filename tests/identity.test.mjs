/**
 * 进站身份的闸门。
 *
 * 这几条断言对应一个**真实发生过的线上故障**：改名会重新签发游客令牌，而令牌里带着
 * 玩家 id；两三张签发同时在飞时，"先发的后到"会把 `S.token` 覆盖掉，于是"建房用的
 * 令牌"和"连 WebSocket 用的令牌"不是同一个人，房主权限当场消失。
 *
 * 它在本地跑一百次都不一定复现，只在跨境链路上现形——所以必须写成测试钉住，
 * 靠手点是靠不住的。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createIdentityGate } from "../web/js/identity.mjs";

/** 一个可以手动控制"什么时候回来"的 promise。 */
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test("慢的旧签发回来时，不能覆盖新签发（房主身份就是这么丢的）", async () => {
  const applied = [];
  const gate = createIdentityGate(data => applied.push(data.playerId));

  const slow = deferred();
  gate.sign("旧名字", () => slow.promise);
  const fast = await gate.sign("新名字", async () => ({ playerId: "g_新", name: "新名字" }));
  assert.equal(fast.playerId, "g_新");

  slow.resolve({ playerId: "g_旧", name: "旧名字" });
  await tick();

  assert.deepEqual(applied, ["g_新"], "过期的那张令牌必须被丢掉，哪怕它先发出、后到达");
});

test("ensure() 等正在飞的那次落定，并且不会重复签", async () => {
  const gate = createIdentityGate(() => {});
  const first = deferred();
  gate.sign("甲", () => first.promise);

  let signed = 0;
  const ensuring = gate.ensure(async () => { signed++; });
  first.resolve({ playerId: "g_甲", name: "甲" });

  assert.equal(await ensuring, true);
  assert.equal(signed, 0, "已经在签了，就不该再签一张");

  assert.equal(await gate.ensure(async () => { signed++; }), true);
  assert.equal(signed, 0, "已经签好了，也不该再签一张");
});

test("签发失败不会假装有身份，下一次 ensure 会真的重签", async () => {
  const gate = createIdentityGate(() => {});
  await gate.sign("甲", async () => { throw new Error("网络炸了"); }).catch(() => {});
  assert.equal(gate.has(), false, "失败之后不能说手上有令牌");

  let attempts = 0;
  const ok = await gate.ensure(async () => {
    attempts++;
    await gate.sign("甲", async () => ({ playerId: "g_甲", name: "甲" }));
  });
  assert.equal(ok, true);
  assert.equal(attempts, 1, "该重签的时候就重签一次");
  assert.equal(gate.has(), true);
});

test("拿到的永远是当前那张：后签的那张说了算", async () => {
  const seen = [];
  const gate = createIdentityGate(data => seen.push(data.playerId));
  await gate.sign("甲", async () => ({ playerId: "g_1", name: "甲" }));
  await gate.sign("乙", async () => ({ playerId: "g_2", name: "乙" }));
  assert.deepEqual(seen, ["g_1", "g_2"]);
  assert.equal(gate.has(), true);
});
