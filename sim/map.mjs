/**
 * 地图生成：网格、墙体、草丛、能量箱。
 *
 * 全部由 `w.seed` 驱动，因此服务端生成一次、把网格发给客户端就够了；客户端
 * 不需要自己重算地图，也就不会出现"两边墙不一样"这种事。
 * 地面贴图是纯表现，放在客户端用独立的 cosmetic 流生成。
 */

import { TILE, GRID, WORLD, circleRect } from "./constants.mjs";
import { ZONE_POINTS, MODES } from "./data.mjs";
import { random } from "./rng.mjs";

export function cell(w, tx, ty) {
  if (tx < 0 || ty < 0 || tx >= GRID || ty >= GRID) return 1;
  return w.grid[ty * GRID + tx];
}

export const solidAt = (w, x, y) => {
  const v = cell(w, Math.floor(x / TILE), Math.floor(y / TILE));
  return v === 1 || v === 2;
};

export const isBush = (w, x, y) => cell(w, Math.floor(x / TILE), Math.floor(y / TILE)) === 3;

export function findOpen(w, x, y) {
  for (let r = 0; r < 9; r++)
    for (let j = -r; j <= r; j++)
      for (let i = -r; i <= r; i++) {
        const tx = Math.floor(x / TILE) + i, ty = Math.floor(y / TILE) + j;
        if (tx > 0 && ty > 0 && tx < GRID - 1 && ty < GRID - 1 && cell(w, tx, ty) !== 1 && cell(w, tx, ty) !== 2)
          return { x: (tx + .5) * TILE, y: (ty + .5) * TILE };
      }
  return { x: WORLD / 2, y: WORLD / 2 };
}

export function canStand(w, a, x, y, ignoreBoxes = false) {
  if (x < a.r + TILE || y < a.r + TILE || x > WORLD - TILE - a.r || y > WORLD - TILE - a.r) return false;
  const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
  for (let j = ty - 1; j <= ty + 1; j++)
    for (let i = tx - 1; i <= tx + 1; i++) {
      const v = cell(w, i, j);
      if ((v === 1 || v === 2) && circleRect(x, y, a.r, { x: i * TILE, y: j * TILE, w: TILE, h: TILE })) return false;
    }
  if (!ignoreBoxes) for (const b of w.boxes) if (b.alive && Math.hypot(x - b.x, y - b.y) < a.r + b.r - 3) return false;
  return true;
}

/** 分步推进，避免高速移动穿墙。 */
export function moveActor(w, a, dx, dy) {
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 9));
  for (let i = 0; i < steps; i++) {
    if (canStand(w, a, a.x + dx / steps, a.y)) a.x += dx / steps;
    if (canStand(w, a, a.x, a.y + dy / steps)) a.y += dy / steps;
  }
  a.x = Math.max(TILE + a.r, Math.min(WORLD - TILE - a.r, a.x));
  a.y = Math.max(TILE + a.r, Math.min(WORLD - TILE - a.r, a.y));
}

export function lineOfSight(w, a, b) {
  const d = Math.hypot(a.x - b.x, a.y - b.y), n = Math.ceil(d / 24);
  for (let i = 1; i < n; i++) {
    const x = a.x + (b.x - a.x) * (i / n), y = a.y + (b.y - a.y) * (i / n);
    if (cell(w, Math.floor(x / TILE), Math.floor(y / TILE)) === 1) return false;
  }
  return true;
}

/**
 * 可见性（草丛隐身机制）。权威端用它决定"这个敌人要不要发给你"，
 * 它同时是玩法规则和反作弊边界：看不见的敌人根本不会出现在你的快照里。
 */
export function visibleTo(w, viewer, target) {
  if (!target.alive) return false;
  if (!isBush(w, target.x, target.y)) return true;
  if (target.revealed > 0) return true;
  return Math.hypot(viewer.x - target.x, viewer.y - target.y) < 145;
}

export function pathfind(w, a, goal) {
  const sx = Math.max(1, Math.min(GRID - 2, Math.floor(a.x / TILE)));
  const sy = Math.max(1, Math.min(GRID - 2, Math.floor(a.y / TILE)));
  const end = findOpen(w, goal.x, goal.y);
  const ex = Math.floor(end.x / TILE), ey = Math.floor(end.y / TILE);
  const start = sy * GRID + sx, target = ey * GRID + ex;
  const queue = [start], prev = new Int16Array(GRID * GRID).fill(-1);
  prev[start] = start;
  let head = 0;
  while (head < queue.length && prev[target] === -1) {
    const n = queue[head++], x = n % GRID, y = Math.floor(n / GRID);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, ni = ny * GRID + nx;
      if (nx > 0 && ny > 0 && nx < GRID - 1 && ny < GRID - 1 && prev[ni] === -1 && cell(w, nx, ny) !== 1 && cell(w, nx, ny) !== 2) {
        prev[ni] = n; queue.push(ni);
      }
    }
  }
  if (prev[target] === -1) return [];
  const path = [];
  let n = target;
  while (n !== start && path.length < GRID * GRID) {
    path.push({ x: (n % GRID + .5) * TILE, y: (Math.floor(n / GRID) + .5) * TILE });
    n = prev[n];
  }
  return path.reverse();
}

export function buildMap(w) {
  w.grid = new Array(GRID * GRID).fill(0);
  w.walls = []; w.bushes = []; w.boxes = [];
  if (w.mode === "control") makeControlMap(w); else makeSurvivalMap(w);
  buildWallLists(w);
}

/** 热点争夺：镜像掩体，五个热点各自有开阔的占点区。 */
function makeControlMap(w) {
  const rect = (x, y, ww, h, v) => {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + ww; i++)
      if (i >= 0 && j >= 0 && i < GRID && j < GRID) w.grid[j * GRID + i] = v;
  };
  rect(0, 0, 31, 1, 1); rect(0, 30, 31, 1, 1); rect(0, 0, 1, 31, 1); rect(30, 0, 1, 31, 1);
  const blocks = [[4, 5, 4, 1], [11, 5, 2, 2], [18, 5, 2, 2], [23, 5, 4, 1], [4, 10, 2, 3], [9, 10, 3, 1],
    [19, 10, 3, 1], [25, 10, 2, 3], [11, 12, 1, 2], [19, 12, 1, 2], [3, 15, 2, 1]];
  for (const [x, y, ww, h] of blocks) { rect(x, y, ww, h, 1); rect(31 - x - ww, 31 - y - h, ww, h, 1); }
  for (const r of [[3, 8, 2, 2], [26, 21, 2, 2], [3, 21, 2, 2], [26, 8, 2, 2]]) rect(...r, 2);
  const grasses = [[7, 7, 3, 2], [21, 22, 3, 2], [21, 7, 3, 2], [7, 22, 3, 2], [6, 12, 2, 3], [23, 16, 2, 3],
    [23, 12, 2, 3], [6, 16, 2, 3], [13, 17, 2, 2], [16, 12, 2, 2], [13, 11, 2, 2], [16, 18, 2, 2]];
  for (const r of grasses) for (let y = r[1]; y < r[1] + r[3]; y++) for (let x = r[0]; x < r[0] + r[2]; x++) if (cell(w, x, y) === 0) w.grid[y * GRID + x] = 3;
  for (const [cx, cy] of ZONE_POINTS)
    for (let y = Math.floor(cy) - 2; y <= Math.floor(cy) + 2; y++)
      for (let x = Math.floor(cx) - 2; x <= Math.floor(cx) + 2; x++)
        if (Math.hypot(x + .5 - cx, y + .5 - cy) < 2.6) w.grid[y * GRID + x] = 0;
  for (const [x, y] of [[13, 21], [17, 21], [13, 9], [17, 9], [6, 18], [24, 12], [6, 12], [24, 18],
    [10, 19], [20, 11], [10, 11], [20, 19], [15, 26], [15, 4]])
    if (cell(w, x, y) === 0) w.boxes.push({ id: w.nextEntity++, x: (x + .5) * TILE, y: (y + .5) * TILE, r: 25, hp: 1850, maxHp: 1850, alive: true });
}

/** 荒野生存：开阔对称的通道，每条路都连通中心。 */
function makeSurvivalMap(w) {
  const rect = (x, y, ww, h, v) => {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + ww; i++)
      if (i > 0 && j > 0 && i < GRID - 1 && j < GRID - 1) w.grid[j * GRID + i] = v;
  };
  for (let i = 0; i < GRID; i++) { w.grid[i] = 1; w.grid[(GRID - 1) * GRID + i] = 1; w.grid[i * GRID] = 1; w.grid[i * GRID + GRID - 1] = 1; }
  const stones = [[5, 5, 3, 1], [5, 6, 1, 2], [11, 3, 1, 3], [15, 5, 3, 1], [21, 4, 1, 3], [25, 7, 3, 1],
    [5, 11, 1, 3], [8, 10, 3, 1], [14, 11, 3, 1], [21, 10, 1, 3], [25, 13, 3, 1], [9, 15, 1, 3],
    [14, 15, 1, 3], [17, 14, 2, 1], [22, 16, 3, 1]];
  for (const [x, y, ww, h] of stones) { rect(x, y, ww, h, 1); rect(31 - x - ww, 31 - y - h, ww, h, 1); }
  [[8, 6, 2, 2], [21, 23, 2, 2], [25, 18, 2, 2], [4, 11, 1, 2]].forEach(r => rect(...r, 2));
  const grassRects = [[2, 3, 2, 4], [8, 3, 2, 2], [13, 4, 2, 3], [22, 4, 3, 2], [25, 9, 3, 3], [3, 8, 3, 2],
    [7, 12, 4, 2], [12, 8, 3, 2], [17, 8, 3, 2], [22, 12, 3, 2], [4, 16, 3, 3], [10, 18, 3, 2],
    [16, 18, 3, 2], [20, 20, 3, 3], [25, 22, 3, 3], [6, 23, 3, 3], [11, 24, 3, 3], [17, 24, 3, 2],
    [19, 27, 3, 2], [3, 26, 2, 2], [14, 13, 3, 2]];
  for (const [x, y, ww, h] of grassRects) for (let j = y; j < y + h; j++) for (let i = x; i < x + ww; i++) if (cell(w, i, j) === 0) w.grid[j * GRID + i] = 3;
  for (let j = 24; j <= 28; j++) for (let i = 14; i <= 17; i++) w.grid[j * GRID + i] = 0;
  const placements = [[15, 24], [17, 25], [13, 25], [3, 4], [5, 3], [9, 4], [14, 3], [18, 4], [23, 3], [27, 5],
    [27, 10], [23, 10], [18, 10], [12, 11], [10, 13], [4, 13], [4, 19], [8, 20], [7, 25], [5, 27],
    [11, 27], [18, 27], [23, 26], [27, 25], [26, 20], [23, 18], [18, 18], [12, 18], [15, 13], [16, 16], [13, 16], [16, 20]];
  placements.forEach(([x, y]) => {
    if (cell(w, x, y) === 0) w.boxes.push({ id: w.nextEntity++, x: (x + .5) * TILE, y: (y + .5) * TILE, r: 25, hp: 2100, maxHp: 2100, alive: true });
  });
}

function buildWallLists(w) {
  for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) {
    const v = cell(w, x, y);
    if (v === 1) w.walls.push({ x: x * TILE, y: y * TILE, w: TILE, h: TILE, tx: x, ty: y, alive: true, border: x === 0 || y === 0 || x === GRID - 1 || y === GRID - 1 });
    if (v === 3) w.bushes.push({ x: x * TILE, y: y * TILE, w: TILE, h: TILE });
  }
}

/** 出生点：热点争夺是六角站位，荒野生存是环形散开。 */
export function spawnPoints(w, index, total) {
  if (w.mode === "control") {
    const spawns = [[15.5, 23.5], [8.5, 22.5], [22.5, 22.5], [15.5, 7.5], [8.5, 8.5], [22.5, 8.5]];
    return spawns[index % spawns.length].map(v => v * TILE);
  }
  const spawns = [[3.1, 3.1], [15.5, 2.1], [27.5, 3], [28, 12], [28, 27], [23.5, 28], [5, 28], [2.3, 20], [3, 10.7], [15.5, 27.3]];
  const fallback = spawns[index % spawns.length];
  const ang = (index / Math.max(1, total)) * Math.PI * 2;
  return index < spawns.length ? [fallback[0] * TILE, fallback[1] * TILE]
    : [(WORLD / 2) + Math.cos(ang) * 780, (WORLD / 2) + Math.sin(ang) * 780];
}

/** 随机找一个空旷点，空投与游走目标都用它。 */
export function openPointAround(w, cx, cy, maxR) {
  const p = findOpen(w, cx + random(w, -maxR, maxR), cy + random(w, -maxR, maxR));
  return p;
}

export const modeConfig = id => MODES[id] || MODES.control;
