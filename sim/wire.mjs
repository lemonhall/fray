/**
 * 线格式（wire format）：世界状态 ↔ 可以过 WebSocket 的普通对象。
 *
 * 这里刻意用 JSON 而不是二进制：这个项目的读者首先是架构师而不是带宽审计员，
 * 打开 DevTools 就能看懂每一帧发了什么，比省下 60% 字节值钱得多。
 * 每个字段名都短到一眼能扫完，但含义在下方注释里写死。
 */

import { GRID, TILE } from "./constants.mjs";
import { visibleTo } from "./map.mjs";

const r1 = v => Math.round(v * 10) / 10;
const r3 = v => Math.round(v * 1000) / 1000;

/** 地图只在开局发一次：网格 961 个字符，墙体与草丛由客户端按同一规则重建。 */
export function encodeMap(w) {
  return {
    t: "map",
    mode: w.mode,
    grid: w.grid.join(""),
    boxes: w.boxes.map(b => [b.id, r1(b.x), r1(b.y), b.hp, b.maxHp]),
    seed: w.matchSeed ?? w.seed,
    difficulty: w.difficulty,
  };
}

export function decodeMap(msg) {
  const grid = Array.from(msg.grid, ch => Number(ch));
  const walls = [], bushes = [];
  for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) {
    const v = grid[y * GRID + x];
    if (v === 1) walls.push({
      x: x * TILE, y: y * TILE, w: TILE, h: TILE, tx: x, ty: y,
      border: x === 0 || y === 0 || x === GRID - 1 || y === GRID - 1,
    });
    if (v === 3) bushes.push({ x: x * TILE, y: y * TILE, w: TILE, h: TILE });
  }
  return {
    mode: msg.mode, grid, walls, bushes, seed: msg.seed, difficulty: msg.difficulty,
    boxes: msg.boxes.map(([id, x, y, hp, maxHp]) => ({ id, x, y, hp, maxHp, r: 25, alive: true })),
  };
}

/**
 * 一帧快照。`selfId` 是接收者的角色 id：可见性过滤以**他**的视角为准，
 * 所以草丛里藏着的敌人根本不会出现在他的报文里。
 */
export function encodeSnapshot(w, selfId) {
  const self = w.actors.find(a => a.id === selfId) || null;
  const actors = [];
  for (const a of w.actors) {
    const mine = self && a.id === self.id;
    if (!mine && !a.alive) continue;
    if (!mine && self && !visibleTo(w, self, a)) continue;
    if (!mine && !self && !a.alive) continue;
    actors.push(actorWire(a, mine));
  }
  return {
    t: "s",
    tk: w.tick,
    ph: w.phase,
    tm: r1(w.time),
    sc: [Math.floor(w.score[0]), Math.floor(w.score[1])],
    z: { x: r1(w.zone.x), y: r1(w.zone.y), r: w.zone.r, ow: w.zone.owner, ct: w.zone.contested ? 1 : 0 },
    rg: { x: r1(w.ring.x), y: r1(w.ring.y), r: w.ring.r },
    a: actors,
    b: w.bullets.map(b => [b.id, r1(b.x), r1(b.y), r1(b.vx), r1(b.vy), b.r, b.ownerId, b.superShot ? 1 : 0, b.hero, b.team]),
    bx: w.boxes.filter(b => !b.alive || b.hp < b.maxHp).map(b => [b.id, r1(b.hp), b.alive ? 1 : 0]),
    cb: w.cubes.map(c => [c.id, r1(c.x), r1(c.y)]),
    gr: w.grenades.map(g => [g.id, r1(g.x), r1(g.y), r1(g.sx), r1(g.sy), g.r, r1(g.at), g.ownerId]),
    fd: w.fields.map(f => [r1(f.x), r1(f.y), f.r, r1(f.until), f.ownerId, f.team]),
    sp: w.supplies.map(s => [s.id, r1(s.x), r1(s.y), s.state, r1(s.at)]),
    ev: w.events,
  };
}

function actorWire(a, mine) {
  const out = {
    i: a.id, n: a.name, k: a.kind === "human" ? 1 : 0, h: a.type, tm: a.team,
    ow: a.ownerId,
    x: r1(a.x), y: r1(a.y), an: r3(a.angle),
    hp: Math.round(a.hp), mh: Math.round(a.maxHp),
    al: a.alive ? 1 : 0, sh: r1(a.shield), dk: a.dash > 0 ? 1 : 0,
    cu: a.cubes, ki: a.kills, wl: r1(a.walk), fl: a.flash > 0 ? 1 : 0,
    hf: a.hitFlash > 0 ? 1 : 0, rs: r1(Math.max(0, a.respawn)),
  };
  if (mine) {
    out.am = r1(a.ammo); out.su = r1(a.super); out.gc = r1(a.gadgetCd);
    out.gd = a.gadget; out.dd = Math.round(a.damage); out.ov = r1(Math.max(0, a.overdrive - 0));
    out.dc = r1(Math.max(0, a.dashCd));
    out.co = a.collected; out.cp = Math.round(a.captureTime);
    out.lv = a.level; out.xp = Math.round(a.xp); out.nx = a.nextXP;
    out.pk = { ...a.perks }; out.of = [...a.offers];
    // 权威确认点：客户端拿它 + 待确认命令重放，就能算出"我现在应该在哪"。
    // 没有这三个字段，客户端只能退回"拿现在的坐标硬比"的老办法（见 predict.mjs）。
    out.ak = a.ack | 0; out.ax = r1(a.ackX); out.ay = r1(a.ackY);
  }
  return out;
}

/** 客户端把快照里的数组形式还原成渲染层好用的对象。 */
export function decodeBullet(arr) {
  const [id, x, y, vx, vy, r, ownerId, superShot, hero, team] = arr;
  return { id, x, y, vx, vy, r, ownerId, superShot: !!superShot, hero, team };
}

export function decodeBox(arr) {
  const [id, hp, alive] = arr;
  return { id, hp, alive: !!alive };
}

export function decodeCube(arr) {
  const [id, x, y] = arr;
  return { id, x, y };
}

export function decodeGrenade(arr) {
  const [id, x, y, sx, sy, r, at, ownerId] = arr;
  return { id, x, y, sx, sy, r, at, ownerId };
}

export function decodeField(arr) {
  const [x, y, r, until, ownerId, team] = arr;
  return { x, y, r, until, ownerId, team };
}

export function decodeSupply(arr) {
  const [id, x, y, state, at] = arr;
  return { id, x, y, state, at };
}
