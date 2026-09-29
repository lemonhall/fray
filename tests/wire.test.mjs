/**
 * 线格式：地图、快照、以及"看不见的敌人不进快照"这条反作弊边界。
 *
 * 这些断言的价值在于它们**不需要浏览器也不需要 workerd**：线格式是纯数据变换，
 * 出了问题一定是这一层的错，不用在别处找。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { GRID, TILE, WORLD } from "../sim/constants.mjs";
import { createWorld, startMatch, fillRoster } from "../sim/world.mjs";
import { encodeMap, decodeMap, encodeSnapshot, decodeBullet } from "../sim/wire.mjs";

function world(mode = "control", bots = 4) {
  const w = createWorld({ tenant: "neon", roomId: "T1", mode, difficulty: 1, seed: 4242 });
  const roster = fillRoster(w, [
    { kind: "human", ownerId: "g_1", name: "我", type: 0, gadget: "heal" },
  ], bots);
  startMatch(w, roster, 4242);
  return w;
}

test("地图编码是可读的紧凑格式，解码能重建出同样的墙与草丛", () => {
  const w = world();
  const msg = encodeMap(w);
  assert.equal(typeof msg.grid, "string");
  assert.equal(msg.grid.length, GRID * GRID);
  assert.ok(!/[^0-3]/u.test(msg.grid), "网格里只有四种格子");

  const map = decodeMap(msg);
  const walls = msg.grid.split("").filter(ch => ch === "1").length;
  const bushes = msg.grid.split("").filter(ch => ch === "3").length;
  assert.equal(map.walls.length, walls);
  assert.equal(map.bushes.length, bushes);
  assert.equal(map.seed, 4242);
  assert.equal(map.mode, "control");
  assert.ok(map.boxes.every(b => b.alive && b.maxHp > 0));
});

test("快照能过 JSON，并且我自己的实体带上了只属于我的字段", () => {
  const w = world();
  const me = w.actors.find(a => a.kind === "human");
  const snap = encodeSnapshot(w, me.id);
  const parsed = JSON.parse(JSON.stringify(snap));
  assert.equal(parsed.t, "s");
  assert.equal(parsed.ph, "live");

  const wireMe = parsed.a.find(a => a.i === me.id);
  assert.ok(wireMe, "我自己必须在快照里");
  for (const key of ["am", "su", "gd", "dd", "ov", "dc", "co", "cp", "lv", "xp", "nx", "pk", "of"]) {
    assert.ok(key in wireMe, `缺字段 ${key}`);
  }
  assert.equal(wireMe.gd, "heal", "开局带的装置跟着人走");

  const enemy = parsed.a.find(a => a.i !== me.id);
  assert.ok(enemy && !("su" in enemy), "别人的弹药与大招不该发给我");
  assert.ok(Array.isArray(parsed.b) && Array.isArray(parsed.gr) && parsed.z && parsed.rg);
});

test("躲在草丛里的敌人根本不会出现在我的快照里，点亮之后才出现", () => {
  const w = world();
  const me = w.actors.find(a => a.kind === "human");
  const enemy = w.actors.find(a => a.id !== me.id && a.team !== me.team);
  me.x = TILE + 60; me.y = TILE + 60;

  const bush = [...w.bushes].sort((a, b) =>
    Math.hypot(b.x - me.x, b.y - me.y) - Math.hypot(a.x - me.x, a.y - me.y))[0];
  assert.ok(bush, "地图里应该有草丛");
  enemy.x = bush.x + TILE / 2;
  enemy.y = bush.y + TILE / 2;
  assert.ok(Math.hypot(enemy.x - me.x, enemy.y - me.y) > 145);

  enemy.revealed = 0;
  assert.equal(encodeSnapshot(w, me.id).a.some(a => a.i === enemy.id), false);
  enemy.revealed = 2;
  assert.equal(encodeSnapshot(w, me.id).a.some(a => a.i === enemy.id), true);
});

test("死掉的敌人不进快照，死掉的我自己还在（要能看见复活倒计时）", () => {
  const w = world();
  const me = w.actors.find(a => a.kind === "human");
  const enemy = w.actors.find(a => a.id !== me.id);
  enemy.alive = false;
  let snap = encodeSnapshot(w, me.id);
  assert.equal(snap.a.some(a => a.i === enemy.id), false);

  me.alive = false; me.respawn = 2.5;
  snap = encodeSnapshot(w, me.id);
  const wireMe = snap.a.find(a => a.i === me.id);
  assert.ok(wireMe);
  assert.equal(wireMe.al, 0);
  assert.equal(wireMe.rs, 2.5);
});

test("子弹解码带回队伍，渲染层才能分清敌我弹道", () => {
  const w = world();
  w.bullets.push({
    id: 99, x: 100, y: 200, px: 100, py: 200, vx: 800, vy: 0, damage: 10,
    remaining: 500, ownerId: 1, team: 1, superShot: false, pierce: false,
    r: 5, hit: [], alive: true, crit: false, bounces: 0, hero: 2,
  });
  const bullet = decodeBullet(encodeSnapshot(w, w.actors[0].id).b[0]);
  assert.equal(bullet.team, 1);
  assert.equal(bullet.hero, 2);
  assert.equal(bullet.superShot, false);
  assert.ok(WORLD > 0 && TILE > 0);
});
