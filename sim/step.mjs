/**
 * 单步推进。固定 60Hz，`stepWorld(w, DT)` 是唯一的推进入口。
 *
 * 顺序很重要，而且必须两边一致：定时任务 → 风暴 → 单位 → 子弹 → 世界机制。
 * 客户端本地预测只调用"单位"那一小段，所以预测不会因为手雷爆炸而抖动。
 */

import { heroOf, perkOf } from "./data.mjs";
import { moveActor } from "./map.mjs";
import { spawnBullet, respawnActor, slam } from "./actor.mjs";
import { poisonTick, breakWall } from "./combat.mjs";
import { updateAI } from "./ai.mjs";
import { stepHuman, applyActions } from "./input.mjs";
import { stepBullets } from "./bullets.mjs";
import { stepGrenades, stepFields, stepSupplies, stepZone, stepStorm, stepCubes } from "./features.mjs";

export function stepWorld(w, dt) {
  if (w.phase !== "live") return;
  w.tick++;
  w.time += dt;
  runScheduled(w);
  stepStorm(w, dt);
  for (const a of w.actors) {
    stepActor(w, a, dt);
    if (w.phase !== "live") return;
  }
  stepBullets(w, dt);
  stepGrenades(w, dt);
  stepFields(w, dt);
  stepSupplies(w, dt);
  if (w.mode === "control") stepZone(w, dt);
  stepCubes(w, dt);
}

function runScheduled(w) {
  for (let i = w.scheduled.length - 1; i >= 0; i--) {
    if (w.time < w.scheduled[i].at) continue;
    const task = w.scheduled.splice(i, 1)[0];
    const a = w.actors.find(v => v.id === task.actorId);
    if (!a || !a.alive) continue;
    if (task.kind === "shot") spawnBullet(w, a, task.angle, task.damage, task.range, task.speed);
  }
}

export function stepActor(w, a, dt) {
  if (!a.alive) {
    if (w.mode === "control") { a.respawn -= dt; if (a.respawn <= 0) respawnActor(w, a); }
    return;
  }
  a.gadgetCd = Math.max(0, a.gadgetCd - dt);
  if (a.kind === "bot") {
    const level = Math.min(5, 1 + Math.floor(w.time / 32));
    if (level > a.botLevel) {
      a.botLevel = level;
      const id = level % 2 ? "reload" : "power";
      a.perks[id] = perkOf(a, id) + 1;
    }
  }
  a.fireCd = Math.max(0, a.fireCd - dt);
  a.flash = Math.max(0, a.flash - dt);
  a.hitFlash = Math.max(0, a.hitFlash - dt);
  a.shield = Math.max(0, a.shield - dt);
  a.revealed = Math.max(0, a.revealed - dt);
  a.dashCd = Math.max(0, a.dashCd - dt);
  // 弹药是连续恢复的，界面上三条弹槽就是这个连续量的三段。
  a.ammo = Math.min(3, a.ammo + dt / heroOf(a.type).reload * (1 + .22 * perkOf(a, "reload")) * (a.overdrive > w.time ? 1.5 : 1));
  if (w.time - Math.max(a.lastDamage, a.lastFire) > 3.5 && a.hp < a.maxHp) {
    a.hp = Math.min(a.maxHp, a.hp + a.maxHp * .115 * dt);
  }
  if (a.dash > 0) {
    const speed = a.superDash ? 875 : 790;
    moveActor(w, a, a.dashX * speed * dt, a.dashY * speed * dt);
    a.dash -= dt;
    if (a.superDash) {
      const tx = Math.floor((a.x + a.dashX * 42) / 64), ty = Math.floor((a.y + a.dashY * 42) / 64);
      breakWall(w, tx, ty);
      if (a.dash <= 0) slam(w, a);
    }
  }
  if (a.kind === "human") { applyActions(w, a); stepHuman(w, a, dt); }
  else updateAI(w, a, dt);
  poisonTick(w, a, dt);
}
