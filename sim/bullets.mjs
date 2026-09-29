/**
 * 子弹推进与命中判定。
 *
 * 子弹是唯一"每帧连续检测"的东西，所以必须分步推进（每步 ≤10px）——否则
 * 高速狙击弹会直接穿过一整个 64px 的格子。命中记录写在 `hit` 数组里而不是
 * Set：快照要 JSON 序列化，Set 过不去。
 */

import { TILE, WORLD } from "./constants.mjs";
import { cell } from "./map.mjs";
import { fxBurst, fxBeam } from "./events.mjs";
import { damageActor, damageBox, breakWall } from "./combat.mjs";
import { isEnemy } from "./actor.mjs";

export function stepBullets(w, dt) {
  for (const b of w.bullets) {
    if (!b.alive) continue;
    b.px = b.x; b.py = b.y;
    const dist = Math.hypot(b.vx, b.vy) * dt;
    const steps = Math.max(1, Math.ceil(dist / 10));
    for (let s = 0; s < steps && b.alive; s++) {
      const ox = b.x, oy = b.y;
      b.x += b.vx * dt / steps; b.y += b.vy * dt / steps; b.remaining -= dist / steps;
      const tx = Math.floor(b.x / TILE), ty = Math.floor(b.y / TILE);
      if (cell(w, tx, ty) === 1) {
        if (b.superShot && breakWall(w, tx, ty)) { if (!b.pierce) b.damage *= .80; }
        else if (b.bounces > 0) {
          b.bounces--; b.damage *= .85;
          const hitX = cell(w, tx, Math.floor(oy / TILE)) === 1;
          const hitY = cell(w, Math.floor(ox / TILE), ty) === 1;
          if (hitX) b.vx *= -1;
          if (hitY) b.vy *= -1;
          if (!hitX && !hitY) { b.vx *= -1; b.vy *= -1; }
          b.x = ox; b.y = oy;
          fxBurst(w, ox, oy, "#9ad9e0", 4, 85, 3);
          continue;
        } else { b.alive = false; fxBurst(w, b.x, b.y, "#85bdcc", 4, 65, 3); break; }
      }
      if (b.remaining <= 0 || b.x < 0 || b.y < 0 || b.x > WORLD || b.y > WORLD) { b.alive = false; break; }

      for (const box of w.boxes) {
        if (box.alive && !b.hit.includes(box.id) && Math.hypot(b.x - box.x, b.y - box.y) < box.r + b.r) {
          damageBox(w, box, b.damage, ownerOf(w, b.ownerId));
          b.hit.push(box.id);
          if (!b.pierce) b.alive = false;
          break;
        }
      }
      if (!b.alive) break;

      for (const a of w.actors) {
        if (!a.alive || !isEnemyId(w, a, b) || b.hit.includes(a.id)) continue;
        if (Math.hypot(b.x - a.x, b.y - a.y + 7) >= a.r + b.r) continue;
        const owner = ownerOf(w, b.ownerId);
        const dealt = damageActor(w, a, b.damage, owner);
        b.hit.push(a.id);
        if (dealt > 0 && owner && owner.type === 3) chainLightning(w, owner, a, b.damage);
        if (!b.pierce) b.alive = false;
        break;
      }
    }
  }
  w.bullets = w.bullets.filter(b => b.alive);
}

const ownerOf = (w, id) => w.actors.find(a => a.id === id) || null;
const isEnemyId = (w, actor, bullet) => {
  if (actor.id === bullet.ownerId) return false;
  if (w.mode !== "control") return true;
  return actor.team !== bullet.team;
};
void isEnemy;

/** 弧光的电弧弹会跳向附近另一名敌人：一次额外的、打折的伤害 + 一道光束。 */
function chainLightning(w, owner, hit, damage) {
  const targets = w.actors
    .filter(v => v.alive && v !== hit && isEnemy(w, owner, v) && Math.hypot(v.x - hit.x, v.y - hit.y) < 190)
    .sort((x, y) => Math.hypot(x.x - hit.x, x.y - hit.y) - Math.hypot(y.x - hit.x, y.y - hit.y));
  if (!targets[0]) return;
  damageActor(w, targets[0], damage * .45, owner, false, true);
  fxBeam(w, hit.x, hit.y - 15, targets[0].x, targets[0].y - 15, "#ffb8ed");
}
