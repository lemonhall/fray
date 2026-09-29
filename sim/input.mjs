/**
 * 把一帧网络输入翻译成动作。人类玩家走这条路，机器人不走。
 *
 * 输入是**意图**而不是结果：客户端说"我往这个方向推、准星在这个角度、开火键按着"，
 * 位置由权威端算。客户端的本地预测跑的是同一段代码，所以只要输入一致，结果就一致。
 */

import { heroOf, perkOf } from "./data.mjs";
import { moveActor } from "./map.mjs";
import { fire, useDash, useGadget, useSuper } from "./actor.mjs";

/** 方向位掩码：1=上 2=右 4=下 8=左。 */
export function decodeMove(bits) {
  const up = bits & 1 ? 1 : 0, right = bits & 2 ? 1 : 0, down = bits & 4 ? 1 : 0, left = bits & 8 ? 1 : 0;
  return { x: right - left, y: down - up };
}

/** 客户端预测与服务端权威共用：只吃已归一化的方向与角度。 */
export function applyMove(w, a, dirX, dirY, dt) {
  const h = heroOf(a.type);
  const len = Math.hypot(dirX, dirY);
  let mx = dirX, my = dirY;
  if (len > 1) { mx /= len; my /= len; }
  const speed = h.speed * (1 + .12 * perkOf(a, "speed")) * (a.overdrive > w.time ? 1 : 1);
  a.vx = mx * speed; a.vy = my * speed;
  if (a.dash <= 0) moveActor(w, a, a.vx * dt, a.vy * dt);
  if (Math.hypot(mx, my) > .05) a.walk += dt * 12;
  return { mx, my };
}

export function stepHuman(w, a, dt) {
  const input = a.input;
  if (!a.alive) return;
  if (!input) { a.vx = 0; a.vy = 0; return; }
  const dir = decodeMove(input.k | 0);
  applyMove(w, a, dir.x, dir.y, dt);
  a.angle = Number.isFinite(input.a) ? input.a : a.angle;
  a.aimRange = Number.isFinite(input.r) ? input.r : 310;
  if (a.offers.length) return; // 正在选卡：不许开火，避免"边选边打"
  if (input.f) fire(w, a, a.angle);
}

/** 一次性动作（闪避 / 装置 / 大招 / 选卡）按帧消费，不会被每个 tick 重复触发。 */
export function applyActions(w, a) {
  const input = a.input;
  if (!input || !a.alive) return;
  const pending = input.act | 0;
  if (!pending) return;
  input.act = 0;
  const dir = decodeMove(input.k | 0);
  if (pending & 1) useDash(w, a, dir.x, dir.y);
  if (pending & 2) useGadget(w, a);
  if (pending & 4) useSuper(w, a);
}
