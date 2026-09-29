/**
 * 本地预测：只预测**我自己**的位移。
 *
 * 为什么可以这么小：`applyMove` 是纯函数，只依赖网格、箱子和移速，不碰随机源，
 * 所以浏览器和服务端算出同一个结果。子弹、伤害、死亡一概不预测——那些必须听
 * 权威端的，否则就会出现"我这边打死了、别人那边还活着"。
 */

import { applyMove } from "/sim/input.mjs";

/** 服务端位置与预测位置的差距超过这个数就直接吸附，否则平滑纠偏。 */
const SNAP_AT = 70;
const BLEND = .22;

export function initPredict(S, map, meSnapshot) {
  S.predictW = {
    mode: map.mode, grid: map.grid, walls: map.walls, bushes: map.bushes, boxes: map.boxes,
    seed: map.seed, time: 0, tick: 0, phase: "live", difficulty: 0,
    actors: [], bullets: [], cubes: [], grenades: [], fields: [], supplies: [], scheduled: [], events: [],
    zone: { x: 0, y: 0, r: 0 }, ring: { x: 0, y: 0, r: 9999 }, score: [0, 0], nextEntity: 1,
  };
  S.predictMe = {
    id: -1, kind: "human", type: meSnapshot.h, ownerId: "",
    x: meSnapshot.x, y: meSnapshot.y, r: 21, angle: meSnapshot.an,
    vx: 0, vy: 0, walk: 0, perks: {}, overdrive: 0, dash: 0, alive: true,
  };
  S.predictW.actors = [S.predictMe];
}

export function stepPredict(S, dt, dirX, dirY, angle) {
  if (!S.predictW) return null;
  const me = S.predictMe;
  me.angle = angle;
  applyMove(S.predictW, me, dirX, dirY, dt);
  return me;
}

/** 权威位置回来了：差太多就认账，差一点点就慢慢拉回来。 */
export function reconcile(S, snapshotMe) {
  const me = S.predictMe;
  if (!me || !snapshotMe) return;
  me.type = snapshotMe.h;
  const dx = snapshotMe.x - me.x, dy = snapshotMe.y - me.y;
  if (Math.hypot(dx, dy) > SNAP_AT || !snapshotMe.al) {
    me.x = snapshotMe.x; me.y = snapshotMe.y;
    return;
  }
  me.x += dx * BLEND;
  me.y += dy * BLEND;
}

/** 箱子被打碎之后就不再挡路，所以预测用的障碍物必须跟着权威端更新。 */
export function applyBoxUpdates(map, rows) {
  for (const [id, hp, alive] of rows) {
    const box = map.boxes.find(b => b.id === id);
    if (!box) continue;
    box.hp = hp;
    box.alive = !!alive;
  }
}
