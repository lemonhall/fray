/**
 * 世界级玩法机制：手雷、共振领域、空投、热点占点、风暴缩圈、能量块。
 *
 * 这里同时是"对局为什么会结束"的第二个入口（第一个是最后一个活人）。
 * 两个入口都走 flow.endMatch，保证结算只有一个出口。
 */

import { TILE, clamp, distance } from "./constants.mjs";
import { ZONE_POINTS, perkOf } from "./data.mjs";
import { random } from "./rng.mjs";
import { findOpen } from "./map.mjs";
import { fxRing, fxBurst, fxSfx, fxAnnounce } from "./events.mjs";
import { damageActor, damageBox, breakWall } from "./combat.mjs";
import { powerMult, isEnemy, grantXP } from "./actor.mjs";
import { endMatch } from "./flow.mjs";

export function stepGrenades(w, dt) {
  for (let i = w.grenades.length - 1; i >= 0; i--) {
    const g = w.grenades[i];
    if (w.time < g.at) continue;
    w.grenades.splice(i, 1);
    const owner = w.actors.find(a => a.id === g.ownerId) || null;
    fxRing(w, g.x, g.y, g.r, "#ffcb91", .55);
    fxBurst(w, g.x, g.y, "#ffb98a", 28, 260, 6);
    for (const wall of w.walls)
      if (wall.alive && !wall.border && Math.hypot(wall.x + 32 - g.x, wall.y + 32 - g.y) < g.r) breakWall(w, wall.tx, wall.ty);
    for (const a of w.actors)
      if (a.alive && owner && isEnemy(w, owner, a) && distance(a, g) < g.r) damageActor(w, a, 1250 * powerMult(owner), owner);
    for (const box of w.boxes)
      if (box.alive && distance(box, g) < g.r) damageBox(w, box, 2500 * (owner ? powerMult(owner) : 1), owner);
    fxSfx(w, "explode", g.x, g.y, g.ownerId, 0, g.team);
  }
}

export function stepFields(w, dt) {
  for (let i = w.fields.length - 1; i >= 0; i--) {
    const f = w.fields[i];
    if (w.time >= f.until) { w.fields.splice(i, 1); continue; }
    f.tick += dt;
    if (f.tick < .25) continue;
    f.tick -= .25;
    const owner = w.actors.find(a => a.id === f.ownerId) || null;
    for (const a of w.actors) {
      if (!a.alive || distance(a, f) >= f.r) continue;
      if (owner && isEnemy(w, owner, a)) damageActor(w, a, 95 * powerMult(owner), owner, false, true);
      else a.hp = Math.min(a.maxHp, a.hp + 125);
    }
  }
}

export function spawnSupply(w) {
  const centre = w.mode === "control" ? w.zone : w.ring;
  const maxR = w.mode === "control" ? 280 : Math.min(420, w.ring.r * .45);
  const pick = () => findOpen(w, centre.x + random(w, -maxR, maxR), centre.y + random(w, -maxR, maxR));
  let p = pick();
  for (let i = 0; i < 12 && w.boxes.some(b => b.alive && distance(b, p) < 60); i++) p = pick();
  w.supplies.push({ id: w.nextEntity++, x: p.x, y: p.y, at: w.time + 3.2, expires: w.time + 35, state: "incoming" });
  if (w.supplies.length > 3) w.supplies.shift();
  fxAnnounce(w, "战术空投", w.mode === "control" ? "补给正在热点附近降落" : "地图标记处有稀有补给");
}

export function stepSupplies(w, dt) {
  if (w.time >= w.nextSupply) {
    w.nextSupply += w.supplyInterval;
    if (w.mode === "control" || w.ring.r > 160) spawnSupply(w);
  }
  for (let i = w.supplies.length - 1; i >= 0; i--) {
    const s = w.supplies[i];
    if (s.state === "incoming" && w.time >= s.at) { s.state = "ready"; fxRing(w, s.x, s.y, 100, "#b1a3ff", .6); }
    if (w.time > s.expires) { w.supplies.splice(i, 1); continue; }
    if (s.state !== "ready") continue;
    const a = w.actors.find(v => v.alive && distance(v, s) < 55);
    if (!a) continue;
    a.hp = Math.min(a.maxHp, a.hp + a.maxHp * .35);
    a.ammo = 3;
    a.super = Math.min(100, a.super + 35);
    a.overdrive = w.time + 7;
    a.collected++;
    w.supplies.splice(i, 1);
    fxRing(w, s.x, s.y, 95, "#bda5ff", .65);
    fxSfx(w, "cube", s.x, s.y, a.id, 0, a.team);
    if (a.kind === "human") { grantXP(w, a, 45); fxBurst(w, a.x, a.y - 110, "#d7bbff", 24, 160, 5); }
  }
}

/** 热点争夺：占点区每 40 秒迁移一次；双方同时在圈内 = 暂停计分。 */
export function stepZone(w, dt) {
  const index = Math.floor(w.time / 40);
  if (index !== w.lastZoneIndex) {
    w.lastZoneIndex = index;
    const p = ZONE_POINTS[index % ZONE_POINTS.length];
    w.zone.x = p[0] * TILE; w.zone.y = p[1] * TILE;
    for (const a of w.actors) { a.pathTimer = 0; a.path = []; }
    fxAnnounce(w, "热点已迁移", "跟随标记，抢先建立优势");
  }
  const count = [0, 0];
  for (const a of w.actors) {
    if (!a.alive) continue;
    if (distance(a, w.zone) < w.zone.r) { count[a.team]++; a.captureTime += dt; grantXP(w, a, dt * 5.2); }
  }
  w.zone.contested = count[0] > 0 && count[1] > 0;
  w.zone.owner = w.zone.contested ? -1 : count[0] > 0 ? 0 : count[1] > 0 ? 1 : -1;
  if (w.zone.owner >= 0) w.score[w.zone.owner] = Math.min(100, w.score[w.zone.owner] + dt * 1.55);
  if (w.score[0] >= 100 || w.score[1] >= 100 || (w.time >= 180 && Math.floor(w.score[0]) !== Math.floor(w.score[1]))) {
    endMatch(w, w.score[0] >= 100 || w.score[1] >= 100 ? "score-cap" : "time");
  }
}

/** 荒野生存：20 秒后开始缩圈，圈外持续掉血。 */
export function stepStorm(w, dt) {
  if (w.mode === "control") { w.ring.r = 9999; return; }
  w.ring.r = w.time < 20 ? 1420 : Math.max(0, 1420 - (w.time - 20) * 9.1);
  if (w.time >= 20 && w.time - dt < 20) fxAnnounce(w, "风暴正在靠近", "沿着青色边界返回安全区");
}

export function stepCubes(w, dt) {
  for (let i = w.cubes.length - 1; i >= 0; i--) {
    const c = w.cubes[i];
    c.life += dt;
    let collector = null;
    for (const a of w.actors) {
      if (!a.alive) continue;
      const d = distance(a, c);
      if (d >= 68 + 90 * perkOf(a, "magnet") || c.life <= .18) continue;
      const rate = clamp(dt * 11, 0, 1);
      c.x += (a.x - c.x) * rate; c.y += (a.y - c.y) * rate;
      if (d < 32) { collector = a; break; }
    }
    if (!collector) continue;
    collector.collected++;
    if (collector.cubes < 12) { collector.cubes++; collector.maxHp += 360; }
    collector.hp = Math.min(collector.maxHp, collector.hp + 480 * (1 + perkOf(collector, "magnet") * .35));
    if (collector.kind === "human") { grantXP(w, collector, 20); fxSfx(w, "cube", c.x, c.y, collector.id); }
    fxRing(w, c.x, c.y, 40, "#e1ffa2", .32);
    w.cubes.splice(i, 1);
  }
}
