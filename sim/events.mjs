/**
 * 事件流：权威端做判定，客户端做表现。
 *
 * 权威端**不**模拟粒子、浮动文字、音效——那些只占 CPU 和内存，却不影响胜负。
 * 它只把"发生了什么"写成事件塞进快照，客户端再用自己的 cosmetic 随机流把事件
 * 变成爆炸、跳字和声音。这样同一个事件在每个客户端看起来都不同，但判定只有一个。
 */

export const MAX_EVENTS = 240;

export function emit(w, ev) {
  if (w.events.length >= MAX_EVENTS) return;
  w.events.push(ev);
}

export const fxRing = (w, x, y, r, c, l = .45) =>
  emit(w, { k: "ring", x: r1(x), y: r1(y), r: Math.round(r), c, l });

export const fxBurst = (w, x, y, c, n = 7, sp = 90, s = 3) =>
  emit(w, { k: "burst", x: r1(x), y: r1(y), c, n, sp: Math.round(sp), s });

export const fxFloat = (w, x, y, text, c, big = false, to = 0, from = 0) =>
  emit(w, { k: "float", x: r1(x), y: r1(y), c, v: text, b: big ? 1 : 0, to, from });

export const fxBeam = (w, x1, y1, x2, y2, c) =>
  emit(w, { k: "beam", x: r1(x1), y: r1(y1), ex: r1(x2), ey: r1(y2), c });

/** 音效带位置与双方 id：客户端据此决定"我自己的动静"还是"远处的动静"。 */
export const fxSfx = (w, s, x, y, from = 0, to = 0, team = -1) =>
  emit(w, { k: "sfx", s, x: x === null ? 0 : r1(x), y: y === null ? 0 : r1(y), from, to, team });

/** 镜头震动只该发生在当事人屏幕上，所以带上归属 id，由客户端过滤。 */
export const fxShake = (w, amount, forId = 0) =>
  emit(w, { k: "shake", m: Math.round(amount * 10) / 10, for: forId });

/** 击杀播报：权威端定名次，客户端只负责排版。 */
export const fxKill = (w, killerName, victimName, mine) =>
  emit(w, { k: "kill", a: killerName, b: victimName, mine: mine ? 1 : 0 });

/** 全屏播报（热点迁移、风暴预警、最终对决）。 */
export const fxAnnounce = (w, title, sub) => emit(w, { k: "announce", a: title, b: sub });

const r1 = v => Math.round(v * 10) / 10;
