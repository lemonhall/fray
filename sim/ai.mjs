/**
 * 机器人决策：找目标、找掩体、找补给、占点、躲子弹。
 *
 * 全部跑在权威端。机器人读的是世界状态，不是"玩家看到的东西"，所以它不会因为
 * 网络延迟而变笨，也不会因为客户端改了一点 JS 就变成神枪手。
 */

import { distance, TAU } from "./constants.mjs";
import { DIFFICULTIES, heroOf, perkOf } from "./data.mjs";
import { random } from "./rng.mjs";
import { moveActor, pathfind, lineOfSight, visibleTo, findOpen } from "./map.mjs";
import { fire, useGadget, useSuper, isEnemy } from "./actor.mjs";

export function autoAim(w, a) {
  let best = null, bestD = Infinity;
  for (const b of [...w.actors, ...w.boxes]) {
    if (!b.alive || b === a) continue;
    const isActor = "type" in b;
    if (isActor && (!isEnemy(w, a, b) || !visibleTo(w, a, b))) continue;
    if (!lineOfSight(w, a, b)) continue;
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    if (d < bestD && d < heroOf(a.type).range + 80) { best = b; bestD = d; }
  }
  return best ? Math.atan2(best.y - a.y, best.x - a.x) : a.angle;
}

export function updateAI(w, a, dt) {
  const h = heroOf(a.type), diff = DIFFICULTIES[w.difficulty];
  a.aiTimer -= dt; a.pathTimer -= dt;

  let target = null, best = 760;
  for (const b of w.actors)
    if (isEnemy(w, a, b) && b.alive && visibleTo(w, a, b)) {
      const d = distance(a, b);
      if (d < best) { best = d; target = b; }
    }

  let crate = null, crateD = 330;
  for (const b of w.boxes) if (b.alive) {
    const d = distance(a, b);
    if (d < crateD && lineOfSight(w, a, b)) { crateD = d; crate = b; }
  }

  let pickup = null, pickD = 230;
  for (const c of w.cubes) {
    const d = Math.hypot(a.x - c.x, a.y - c.y);
    if (d < pickD && Math.hypot(c.x - w.ring.x, c.y - w.ring.y) < w.ring.r - 25) { pickup = c; pickD = d; }
  }
  for (const c of w.supplies) if (c.state === "ready" && distance(a, c) < pickD) { pickup = c; pickD = distance(a, c); }

  const edge = Math.hypot(a.x - w.ring.x, a.y - w.ring.y) > w.ring.r - 95;
  const combat = target && best < h.range * .94 && lineOfSight(w, a, target);
  let goal = null, moveX = 0, moveY = 0;

  if (edge) {
    goal = { x: w.ring.x + Math.cos(a.strategy) * Math.max(0, w.ring.r * .30), y: w.ring.y + Math.sin(a.strategy) * Math.max(0, w.ring.r * .30) };
  } else if (pickup && (!combat || pickD < 95)) {
    goal = pickup;
  } else if (w.mode === "control" && (!combat || distance(a, w.zone) > w.zone.r * .72)) {
    goal = { x: w.zone.x + Math.cos(a.strategy) * 45, y: w.zone.y + Math.sin(a.strategy) * 45 };
  } else if (combat) {
    const dx = target.x - a.x, dy = target.y - a.y, d = Math.max(1, Math.hypot(dx, dy));
    const desired = a.type === 1 ? 185 : a.type === 2 ? 500 : 320;
    const approach = best > desired ? 1 : best < desired * .72 ? -1 : 0;
    const strafe = Math.sin(w.time * 1.5 + a.strategy) > .1 ? .65 : -.65;
    moveX = dx / d * approach - dy / d * strafe;
    moveY = dy / d * approach + dx / d * strafe;
    if (a.hp < a.maxHp * .28) { moveX = -dx / d + moveX * .3; moveY = -dy / d + moveY * .3; }
  } else if (crate) {
    goal = crate;
  } else if (target && best < 700) {
    goal = target;
  } else {
    if (!a.goal || distance(a, a.goal) < 65 || w.time % 8 < dt) {
      const rmax = Math.min(600, w.ring.r * .65), ang = random(w, 0, TAU);
      a.goal = findOpen(w, w.ring.x + Math.cos(ang) * random(w, 100, rmax), w.ring.y + Math.sin(ang) * random(w, 100, rmax));
    }
    goal = a.goal;
  }

  const shootAt = combat ? target : crate;
  if (shootAt) {
    const predictive = "vx" in shootAt ? Math.min(.4, distance(a, shootAt) / h.shotSpeed) : 0;
    a.angle = Math.atan2(
      shootAt.y + (shootAt.vy || 0) * predictive - a.y,
      shootAt.x + (shootAt.vx || 0) * predictive - a.x,
    );
    if (a.aiTimer <= 0 && distance(a, shootAt) < h.range * .96 && lineOfSight(w, a, shootAt)) {
      if (a.ammo >= 1) fire(w, a, a.angle + random(w, -diff.accuracy, diff.accuracy));
      a.aiTimer = diff.react + random(w, .08, .25);
      if (combat && a.super >= 100 && best < (a.type === 1 ? 400 : h.range)) useSuper(w, a);
    }
  }

  if (goal) {
    if (a.pathTimer <= 0) { a.path = pathfind(w, a, goal); a.pathTimer = random(w, .5, .85); }
    while (a.path.length && distance(a, a.path[0]) < 15) a.path.shift();
    const next = a.path[0] || goal;
    const d = Math.hypot(next.x - a.x, next.y - a.y);
    if (d > 8) { moveX = (next.x - a.x) / d; moveY = (next.y - a.y) / d; }
    if (crate && goal === crate && crateD < Math.min(h.range * .65, 190)) { moveX = 0; moveY = 0; }
  }

  // 感知式闪避：只躲"看得见的来弹"，不读心。
  if (w.difficulty > 0) for (const b of w.bullets) {
    if (!b.alive || distance(a, b) > 180) continue;
    if (w.mode === "control" && b.team === a.team) continue;
    const dx = a.x - b.x, dy = a.y - b.y, speed = Math.hypot(b.vx, b.vy) || 1;
    const along = (dx * b.vx + dy * b.vy) / speed, cross = (dx * b.vy - dy * b.vx) / speed;
    if (along > 0 && Math.abs(cross) < 44) {
      const side = cross > 0 ? 1 : -1;
      moveX += b.vy / speed * side * .9; moveY -= b.vx / speed * side * .9;
      break;
    }
  }

  if (combat && w.time > 8 && a.gadgetCd <= 0 &&
    ((a.gadget === "grenade" && best < 380) || (a.gadget === "shield" && a.hp < a.maxHp * .6) || (a.gadget === "heal" && a.hp < a.maxHp * .5)))
    useGadget(w, a);

  // 软分离，防止一堆单位在窄路口糊成一团。
  for (const b of w.actors) {
    if (a === b || !b.alive) continue;
    const d = distance(a, b);
    if (d > 0 && d < 47) { moveX += (a.x - b.x) / d * .55; moveY += (a.y - b.y) / d * .55; }
  }

  const len = Math.hypot(moveX, moveY);
  if (len > 1) { moveX /= len; moveY /= len; }
  const speedScale = diff.speed * (1 + .12 * perkOf(a, "speed"));
  a.vx = moveX * h.speed * speedScale;
  a.vy = moveY * h.speed * speedScale;
  if (a.dash <= 0) moveActor(w, a, a.vx * dt, a.vy * dt);
  if (len > .05) a.walk += dt * 11;
}
