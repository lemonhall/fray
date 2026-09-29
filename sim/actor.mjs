/**
 * 参战单位（人类玩家与机器人共用同一个结构）与它们能做的事：
 * 开火、闪避、战术装置、超级技能、升级。
 *
 * `kind` 是唯一的区别标记：`human` 每 tick 吃网络输入，`bot` 每 tick 吃 AI 决策。
 * 两者走完全相同的移动、碰撞、伤害路径——这正是"人机混战"能公平的原因。
 */

import { WORLD, clamp, distance } from "./constants.mjs";
import { GADGETS, PERKS, DIFFICULTIES, perkById, perkOf, heroOf } from "./data.mjs";
import { nextRnd, random } from "./rng.mjs";
import { moveActor, findOpen } from "./map.mjs";
import { fxRing, fxBurst, fxFloat, fxSfx, fxShake } from "./events.mjs";
import { damageActor, damageBox, breakWall } from "./combat.mjs";

export const powerMult = a => (1 + a.cubes * .10) * (1 + .14 * perkOf(a, "power"));
export const dashCooldown = a => 6 * Math.pow(.75, perkOf(a, "dash"));
export const gadgetCooldown = a => GADGETS[a.gadget].cooldown * Math.pow(.75, perkOf(a, "cooling"));

export function newActor(w, { id, kind, ownerId = "", type, x, y, team, name, gadget }) {
  const h = heroOf(type);
  const pick = GADGETS[gadget] ? gadget : ["grenade", "shield", "heal"][id % 3];
  return {
    id, kind, ownerId, type, name, team,
    x, y, spawnX: x, spawnY: y, r: 21,
    vx: 0, vy: 0, angle: -Math.PI / 2, walk: 0,
    hp: h.hp, maxHp: h.hp, ammo: 3, super: 0, cubes: 0, alive: true,
    lastDamage: -10, lastFire: -10, fireCd: kind === "human" ? 0 : 1 + nextRnd(w),
    flash: 0, hitFlash: 0, shield: 2.2, dash: 0, dashX: 0, dashY: 0, dashCd: 0,
    superDash: false, poisonTick: 0, kills: 0, deaths: 0, damage: 0,
    path: [], pathTimer: 0, aiTimer: random(w, 0, .2), goal: null, strategy: random(w, 0, Math.PI * 2),
    revealed: 0, perks: {}, gadget: pick,
    gadgetCd: kind === "human" ? 0 : random(w, 5, 11), respawn: 0, collected: 0, captureTime: 0,
    overdrive: 0, lastBlast: -10, botLevel: 1,
    level: 1, xp: 0, nextXP: 70, pendingUpgrades: 0, offers: [],
    lastInputSeq: 0,
    aimRange: 310,
  };
}

export function respawnActor(w, a) {
  const p = findOpen(w, a.spawnX, a.spawnY);
  a.x = p.x; a.y = p.y; a.hp = a.maxHp; a.alive = true; a.ammo = 3; a.shield = 2.2;
  a.lastDamage = w.time; a.lastFire = w.time; a.fireCd = .2; a.path = []; a.pathTimer = 0;
  a.respawn = 0; a.dash = 0; a.superDash = false;
  fxRing(w, a.x, a.y, 90, a.team === 0 ? "#78ffe6" : "#ff9ab7", .7);
}

export function grantXP(w, a, amount) {
  if (!Number.isFinite(amount) || amount <= 0 || a.level >= 6) return;
  a.xp += amount;
  while (a.xp >= a.nextXP && a.level < 6) { a.xp -= a.nextXP; a.level++; a.nextXP = 70 + (a.level - 1) * 25; a.pendingUpgrades++; }
  if (a.level >= 6) a.xp = a.nextXP;
  if (a.pendingUpgrades > 0 && !a.offers.length) rollOffers(w, a);
}

/** 三选一：候选与顺序都由权威端的随机流决定，客户端只负责显示。 */
export function rollOffers(w, a) {
  const candidates = PERKS.filter(p => perkOf(a, p.id) < p.max);
  a.offers = [];
  while (a.offers.length < 3 && candidates.length) {
    const index = Math.floor(nextRnd(w) * candidates.length);
    a.offers.push(candidates.splice(index, 1)[0].id);
  }
}

export function applyPerk(w, a, id) {
  const p = perkById(id);
  if (!p || perkOf(a, id) >= p.max || !a.offers.includes(id)) return false;
  a.perks[id] = perkOf(a, id) + 1;
  if (id === "vitality") { const gain = Math.round(heroOf(a.type).hp * .18); a.maxHp += gain; a.hp = Math.min(a.maxHp, a.hp + gain); }
  if (id === "cooling") a.gadgetCd = Math.max(0, a.gadgetCd - 4);
  a.pendingUpgrades = Math.max(0, a.pendingUpgrades - 1);
  a.offers = [];
  if (a.pendingUpgrades > 0) rollOffers(w, a);
  fxSfx(w, "cube", a.x, a.y, a.id);
  fxFloat(w, a.x, a.y - 115, p.name + "！", "#cdbdff", true, a.id);
  return true;
}

export function spawnBullet(w, a, angle, damage, range, speed, opts = {}) {
  const { superShot = false, pierce = false, radius = 5 } = opts;
  const x = a.x + Math.cos(angle) * 29, y = a.y + Math.sin(angle) * 29 - 10;
  const crit = nextRnd(w) < perkOf(a, "crit") * .16;
  const diff = a.kind === "bot" ? DIFFICULTIES[w.difficulty].damage : 1;
  w.bullets.push({
    id: w.nextEntity++, x, y, px: x, py: y,
    vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
    damage: damage * powerMult(a) * diff * (crit ? 1.65 : 1),
    remaining: range, ownerId: a.id, team: a.team, superShot, pierce, r: radius,
    hit: [], alive: true, crit, bounces: perkOf(a, "ricochet"), hero: a.type,
  });
  a.flash = .10;
}

export function fire(w, a, angle) {
  if (!a.alive || a.ammo < .999 || a.fireCd > 0 || w.phase !== "live") return false;
  const h = heroOf(a.type);
  a.ammo = Math.max(0, a.ammo - 1);
  a.fireCd = h.interval / (a.overdrive > w.time ? 1.4 : 1);
  a.lastFire = w.time; a.revealed = 1.3; a.angle = angle;
  if (a.type === 0) {
    for (let i = 0; i < 3; i++) {
      if (i === 0) spawnBullet(w, a, angle, h.damage, h.range, h.shotSpeed);
      else w.scheduled.push({ at: w.time + i * .08, kind: "shot", actorId: a.id, angle: angle + random(w, -.018, .018), damage: h.damage, range: h.range, speed: h.shotSpeed });
    }
  }
  if (a.type === 1) for (let i = -2; i <= 2; i++) spawnBullet(w, a, angle + i * .14, h.damage, h.range, h.shotSpeed, { radius: 6 });
  if (a.type === 2) spawnBullet(w, a, angle, h.damage, h.range, h.shotSpeed, { radius: 5 });
  if (a.type === 3) spawnBullet(w, a, angle, h.damage, h.range, h.shotSpeed, { radius: 8 });
  fxSfx(w, a.type === 2 ? "sniper" : "shot", a.x, a.y, a.id, 0, a.team);
  if (a.kind === "human") fxShake(w, a.type === 2 ? 1.8 : .55, a.id);
  return true;
}

export function useSuper(w, a) {
  if (!a || !a.alive || a.super < 99.99 || w.phase !== "live") return false;
  a.super = 0; a.lastFire = w.time; a.revealed = 2;
  const h = heroOf(a.type);
  fxSfx(w, "super", a.x, a.y, a.id, 0, a.team);
  fxFloat(w, a.x, a.y - 85, h.superName, "#fff5a7", true, a.id);
  if (a.type === 0) for (let i = -5; i <= 5; i++) spawnBullet(w, a, a.angle + i * .095, 670, 730, 930, { superShot: true, radius: 8 });
  if (a.type === 1) { a.dash = .48; a.dashX = Math.cos(a.angle); a.dashY = Math.sin(a.angle); a.superDash = true; a.shield = Math.max(a.shield, .6); fxRing(w, a.x, a.y, 70, "#b2f1de"); }
  if (a.type === 2) { spawnBullet(w, a, a.angle, 2700, 1200, 1400, { superShot: true, pierce: true, radius: 13 }); fxRing(w, a.x, a.y, 55, "#e9d7fd", .28); }
  if (a.type === 3) { w.fields.push({ x: a.x, y: a.y, r: 210, until: w.time + 6, ownerId: a.id, team: a.team, tick: 0 }); fxRing(w, a.x, a.y, 210, "#ffc2f1", .5); }
  if (a.kind === "human") fxShake(w, 5, a.id);
  return true;
}

export function useGadget(w, a) {
  if (w.phase !== "live" || !a || !a.alive || a.gadgetCd > 0) return false;
  if (a.gadget === "heal" && a.hp >= a.maxHp) return false;
  a.gadgetCd = gadgetCooldown(a); a.revealed = 1;
  if (a.gadget === "grenade") {
    const range = clamp(a.aimRange || 310, 55, 380);
    w.grenades.push({
      id: w.nextEntity++,
      x: clamp(a.x + Math.cos(a.angle) * range, 85, WORLD - 85),
      y: clamp(a.y + Math.sin(a.angle) * range, 85, WORLD - 85),
      sx: a.x, sy: a.y - 16, r: 150, at: w.time + .8, born: w.time, ownerId: a.id, team: a.team,
    });
  } else if (a.gadget === "shield") {
    a.shield = Math.max(a.shield, 1.6); fxRing(w, a.x, a.y, 68, "#c3b2ff", .5);
  } else {
    const healed = Math.min(a.maxHp - a.hp, a.maxHp * .33);
    a.hp += healed;
    fxFloat(w, a.x, a.y - 105, "+" + Math.round(healed), "#9affd1", true, a.id);
    fxRing(w, a.x, a.y, 95, "#a0ffe0", .55); fxBurst(w, a.x, a.y - 10, "#9affd6", 18, 100, 4);
  }
  fxSfx(w, "dash", a.x, a.y, a.id, 0, a.team);
  return true;
}

export function useDash(w, a, mx, my) {
  if (!a || !a.alive || a.dashCd > 0 || w.phase !== "live") return false;
  const l = Math.hypot(mx, my);
  if (l > .1) { mx /= l; my /= l; } else { mx = Math.cos(a.angle); my = Math.sin(a.angle); }
  a.dash = .18; a.dashX = mx; a.dashY = my; a.dashCd = dashCooldown(a);
  a.shield = Math.max(a.shield, .20); a.superDash = false;
  fxSfx(w, "dash", a.x, a.y, a.id, 0, a.team); fxRing(w, a.x, a.y, 42, "#e3f9ca", .25);
  return true;
}

export function slam(w, a) {
  a.superDash = false;
  fxRing(w, a.x, a.y, 185, "#d1f6c2", .6); fxBurst(w, a.x, a.y, "#c4ecbf", 25, 240, 6);
  for (const b of w.actors) if (b.alive && isEnemy(w, a, b) && distance(a, b) < 185) {
    damageActor(w, b, 1900 * powerMult(a), a);
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    moveActor(w, b, Math.cos(ang) * 55, Math.sin(ang) * 55);
  }
  for (const b of w.boxes) if (b.alive && distance(a, b) < 185) damageBox(w, b, 3000, a);
  for (const wl of w.walls) if (wl.alive && !wl.border && Math.hypot(wl.x + 32 - a.x, wl.y + 32 - a.y) < 165) breakWall(w, wl.tx, wl.ty);
  fxShake(w, 11, a.id);
}

/** 敌我关系：热点争夺按队伍，荒野生存人人都是敌人。 */
export const isEnemy = (w, a, b) => a !== b && (w.mode !== "control" || a.team !== b.team);

export function actorById(w, id) {
  return w.actors.find(a => a.id === id) || null;
}
