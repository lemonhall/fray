/**
 * 共享内核的常量层：纯数据 + 纯函数，不碰 DOM、不碰 Node、不碰 Cloudflare API。
 *
 * 这一层被两个宿主同时 import：Durable Object（权威端）与浏览器（预测与渲染）。
 * 只要这里出现任何宿主专属的东西，两边就会开始漂移，所以这里是硬边界。
 */

export const TAU = Math.PI * 2;
export const TILE = 64;
export const GRID = 31;
export const WORLD = TILE * GRID;

/** 固定步长：60Hz。客户端与服务端必须用同一个 dt 推进，否则模拟会漂。 */
export const TICK_HZ = 60;
export const DT = 1 / TICK_HZ;

/** 服务端每 3 个 tick（50ms / 20Hz）广播一次快照。 */
export const SNAPSHOT_EVERY_TICKS = 3;

/**
 * 单次补算最多多少步（60Hz 下的 4 秒），防止长时间挂起后把 DO 的 CPU 拖爆。
 *
 * 这个上限原来是 30（0.5 秒），太紧了：跨境链路上一次 500ms 的消息断流就会让
 * 世界"丢掉"多出来的那段墙上时间，而客户端的本地预测走的是真实时间，两边于是
 * 差出上百像素——表现就是"人往前走了一段，又被拽回去一小段"。
 * 玩家自己的移动时间现在由输入命令队列兜着（`sim/netcode.mjs`），世界的时间
 * 就不该再随便丢：240 步的补算对 DO 来说只是几毫秒的事。
 */
export const MAX_CATCHUP_TICKS = 240;

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const round = n => Math.round(n);
export const clock = n =>
  `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(Math.floor(n % 60)).padStart(2, "0")}`;

/** 圆形与轴对齐矩形是否相交。 */
export function circleRect(x, y, r, o) {
  const nx = clamp(x, o.x, o.x + o.w);
  const ny = clamp(y, o.y, o.y + o.h);
  return (x - nx) ** 2 + (y - ny) ** 2 < r * r;
}
