/**
 * 伤害结算：掩体破坏、伤害归属、淘汰与掉落。
 *
 * 这些函数是整局里唯一能把 `hp` 打到 0 的地方。放在同一层，是为了让
 * "谁打死了谁"永远只有一条推导路径，排查对枪纠纷时不需要满仓库找。
 */

import { GRID, distance } from "./constants.mjs";
import { heroOf, perkOf } from "./data.mjs";
import { random } from "./rng.mjs";
import { fxRing, fxBurst, fxFloat, fxSfx, fxKill, fxShake } from "./events.mjs";
import { powerMult, grantXP, isEnemy } from "./actor.mjs";
import { endMatch, checkSurvivalEnd } from "./flow.mjs";

export function breakWall(w, tx, ty) {
  const wall = w.walls.find(x => x.tx === tx && x.ty === ty && x.alive);
  if (!wall || wall.border) return false;
  wall.alive = false;
  w.grid[ty * GRID + tx] = 0;
  fxBurst(w, wall.x + 32, wall.y + 32, "#d9bd8a", 13, 160, 8);
  return true;
}

export function damageBox(w, box, damage, owner) {
  if (!box.alive) return;
  const dealt = Math.min(box.hp, damage);
  box.hp -= damage;
  if (owner && owner.alive) {
    owner.super = Math.min(100, owner.super + dealt / 150 * (1 + .3 * perkOf(owner, "charge")));
  }
  if (box.hp <= 0) {
    box.alive = false;
    fxBurst(w, box.x, box.y, "#66a8bc", 16, 170, 6);
    w.cubes.push({ id: w.nextEntity++, x: box.x, y: box.y, life: 0, bob: 0 });
    if (owner && owner.kind === "human") { grantXP(w, owner, 18); fxSfx(w, "cube", box.x, box.y, owner.id); }
  }
}

export function damageActor(w, actor, damage, owner = null, poison = false, secondary = false) {
  if (!actor.alive || w.phase !== "live" || !Number.isFinite(damage) || damage <= 0) return 0;
  if (owner && owner !== actor && !isEnemy(w, actor, owner)) return 0;
  if (actor.shield > 0 && !poison) return 0;
  const dealt = Math.min(actor.hp, damage);
  actor.hp = Math.max(0, actor.hp - damage);
  actor.lastDamage = w.time; actor.hitFlash = .11; actor.revealed = 1.2;

  if (owner && owner !== actor && owner.alive) {
    owner.super = Math.min(100, owner.super + dealt / 55 * (1 + .3 * perkOf(owner, "charge")));
    owner.damage += dealt;
    owner.hp = Math.min(owner.maxHp, owner.hp + dealt * perkOf(owner, "leech") * .08);
    grantXP(w, owner, dealt * .008);
  }
  if (!poison) fxBurst(w, actor.x, actor.y - 10, heroOf(actor.type).light, 5, 100, 4);
  fxSfx(w, "hit", actor.x, actor.y, owner ? owner.id : 0, actor.id, actor.team);
  if (owner) fxShake(w, 2, actor.id);
  if (!poison || (owner && owner.kind === "human")) {
    fxFloat(w, actor.x, actor.y - 58, String(Math.round(dealt)),
      poison ? "#ff9bc3" : "#dcffef", dealt > 1000, actor.id, owner ? owner.id : 0);
  }
  if (actor.hp <= 0) eliminate(w, actor, owner, poison);

  if (owner && owner.alive && !poison && !secondary && perkOf(owner, "blast") && w.time - owner.lastBlast >= 2.5) {
    owner.lastBlast = w.time;
    fxRing(w, actor.x, actor.y, 110, "#ffce96", .35);
    for (const other of w.actors)
      if (other.alive && other !== actor && isEnemy(w, owner, other) && distance(actor, other) < 110)
        damageActor(w, other, damage * .3, owner, false, true);
  }
  return dealt;
}

export function eliminate(w, actor, killer, poison = false) {
  if (!actor.alive) return;
  actor.alive = false; actor.hp = 0; actor.vx = 0; actor.vy = 0; actor.deaths++;
  const drops = w.mode === "control" ? 1 : Math.max(1, Math.ceil(actor.cubes / 2));
  for (let i = 0; i < drops; i++) {
    w.cubes.push({ id: w.nextEntity++, x: actor.x + random(w, -22, 22), y: actor.y + random(w, -22, 22), life: 0, bob: 0 });
  }
  fxBurst(w, actor.x, actor.y - 12, heroOf(actor.type).color, 28, 210, 7);
  fxRing(w, actor.x, actor.y, 77, heroOf(actor.type).light, .55);

  if (killer && killer !== actor) {
    killer.kills++;
    killer.super = Math.min(100, killer.super + 15);
    grantXP(w, killer, 30);
    killer.combo = w.time - (killer.lastKill || -99) < 7 ? (killer.combo || 0) + 1 : 1;
    killer.lastKill = w.time;
    if (killer.combo >= 2) fxFloat(w, actor.x, actor.y - 95, killer.combo + " 连击！", "#81ffe0", true, killer.id);
    else fxFloat(w, actor.x, actor.y - 95, "淘汰！", "#81ffe0", true, killer.id);
  }
  fxSfx(w, "kill", actor.x, actor.y, killer ? killer.id : 0, actor.id, actor.team);
  fxKill(w, killer ? killer.name : "风暴", actor.name, false);
  fxShake(w, 3, killer ? killer.id : 0);

  if (w.mode === "control") {
    actor.respawn = 4; actor.superDash = false; actor.dash = 0;
    return;
  }
  actor.rank = w.actors.filter(a => a.alive).length + 1;
  checkSurvivalEnd(w);
}

/** 风暴（毒圈）伤害：不吃护盾，也没有击杀归属。 */
export function poisonTick(w, actor, dt) {
  if (Math.hypot(actor.x - w.ring.x, actor.y - w.ring.y) > w.ring.r) {
    actor.poisonTick += dt;
    if (actor.poisonTick >= .5) { actor.poisonTick -= .5; damageActor(w, actor, 180 + w.time * 2.7, null, true); }
  } else actor.poisonTick = 0;
}

export { endMatch };
