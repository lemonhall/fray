/**
 * 表现层效果：爆炸、跳字、扩散环、光束、击杀播报。
 *
 * 全部由**事件**驱动——权威端说"这里发生了一次爆炸"，客户端自己决定炸成什么样。
 * 用的是独立的 cosmetic 随机流，所以表现层的随机永远不会影响判定。
 */

import { TAU } from "/sim/constants.mjs";
import { cosmeticRng } from "/sim/rng.mjs";
import { FX, S } from "./state.mjs";
import { playEvent } from "./audio.mjs";

let rnd = cosmeticRng(1);
export function seedFx(seed) { rnd = cosmeticRng((seed ^ 0x9e3779b9) >>> 0); }
const between = (a, b) => a + rnd() * (b - a);

export function burst(x, y, color, count = 7, speed = 90, size = 3) {
  for (let i = 0; i < count; i++) {
    const ang = between(0, TAU), v = between(speed * .3, speed);
    FX.particles.push({
      x, y, vx: Math.cos(ang) * v, vy: Math.sin(ang) * v,
      life: between(.18, .5), max: .5, color, size: between(1, size), drag: 2,
    });
  }
}

export function floater(x, y, text, color = "#fff9d1", big = false) {
  FX.floaters.push({ x, y, text, color, big, life: .85, max: .85, vy: -43 });
}

export function ring(x, y, max, color, life = .45) {
  FX.rings.push({ x, y, max, color, life, total: life });
}

export function beam(x, y, ex, ey, color) {
  FX.beams.push({ x, y, ex, ey, color, life: .18 });
}

export function killFeed(who, target, mine) {
  FX.feed.unshift({ who, target, mine, at: performance.now() });
  FX.feed = FX.feed.slice(0, 4);
}

/** 把一次快照里的事件全部放出来。这是"权威判定 → 本地表现"的唯一通道。 */
export function consumeEvents(events) {
  if (!events) return;
  for (const ev of events) {
    switch (ev.k) {
      case "burst": burst(ev.x, ev.y, ev.c, ev.n, ev.sp, ev.s); break;
      case "ring": ring(ev.x, ev.y, ev.r, ev.c, ev.l); break;
      case "beam": beam(ev.x, ev.y, ev.ex, ev.ey, ev.c); break;
      case "float":
        if (ev.to && S.me && ev.to === S.me.i) floater(ev.x, ev.y, ev.v, ev.c, !!ev.b);
        else if (ev.from && S.me && ev.from === S.me.i) {
          floater(ev.x, ev.y, ev.v, "#dcffef", !!ev.b);
          S.hitUntil = performance.now() + 110;
        }
        break;
      case "sfx": playEvent(S, ev); break;
      case "shake": if (!ev.for || (S.me && ev.for === S.me.i)) S.shake = Math.min(11, S.shake + ev.m); break;
      case "kill": killFeed(ev.a, ev.b, !!ev.mine); break;
      case "announce": FX.announce = { title: ev.a, sub: ev.b, at: performance.now() }; break;
      default: break;
    }
  }
}

export function stepFx(dt) {
  for (const p of FX.particles) {
    p.life -= dt; p.x += p.vx * dt; p.y += p.vy * dt;
    p.vx *= 1 - dt * p.drag; p.vy *= 1 - dt * p.drag;
  }
  FX.particles = FX.particles.filter(p => p.life > 0);
  if (FX.particles.length > 700) FX.particles.splice(0, FX.particles.length - 700);
  for (const f of FX.floaters) { f.life -= dt; f.y += f.vy * dt; }
  FX.floaters = FX.floaters.filter(f => f.life > 0);
  for (const r of FX.rings) r.life -= dt;
  FX.rings = FX.rings.filter(r => r.life > 0);
  for (const b of FX.beams) b.life -= dt;
  FX.beams = FX.beams.filter(b => b.life > 0);
  S.shake = Math.max(0, S.shake - dt * 24);
  if (FX.announce && performance.now() - FX.announce.at > 2300) FX.announce = null;
}
