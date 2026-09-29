/**
 * 确定性随机源。整局对局的可复现性全押在这一处。
 *
 * 每条流都写在世界对象上（`w.seed`），不存模块级变量：DO 里同时可能存在多个
 * 对局对象，模块级状态会被它们串味。
 */

/** 线性同余发生器，参数与原作者的单机版一致（同一颗种子 = 同一局）。 */
export function nextRnd(w) {
  w.seed = (w.seed * 1664525 + 1013904223) >>> 0;
  return w.seed / 4294967296;
}

export const random = (w, a, b) => a + nextRnd(w) * (b - a);
export const choose = (w, arr) => arr[Math.floor(nextRnd(w) * arr.length)];

/**
 * 纯表现用随机源：粒子、浮动文字、地面纹理。
 *
 * 它刻意与 `w.seed` 分离。表现层如果偷用模拟流，一个客户端少画一次粒子，
 * 整局后续的暴击判定就会错位——这是典型的"看不见的 desync"。
 */
export function cosmeticRng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
