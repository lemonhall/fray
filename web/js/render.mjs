/**
 * 主渲染：地面、场景物件、单位、子弹、风暴、跳字。
 *
 * 逐行移植自原单机版，唯一的结构性变化是"所有输入都从 V（视图对象）来"，
 * 而不是读一堆模块级全局变量。这样同一段画法既能画权威快照，也能画预测位置，
 * 而且再也不会出现"改了一个全局变量，另一个界面莫名其妙跟着变"。
 *
 * 这个文件只管**相机、排序、裁剪**这几件事——"每样东西长什么样"都在
 * `arena-draw.mjs` 里。分开的理由很实在：一个是"什么时候画"，一个是"画成什么"，
 * 合在一起就会长成三百多行的函数堆，改一处就得通读全文。
 */

import { TILE, GRID, WORLD, clamp } from "/sim/constants.mjs";
import { cell } from "/sim/map.mjs";
import { cosmeticRng } from "/sim/rng.mjs";
import { rr, ellipse, poly, line, drawCrate, drawBush, drawWall } from "./sprites.mjs";
import { FX, S } from "./state.mjs";
import {
  allyTeam, bulletColor, drawStorm, drawActor, drawAim,
  drawWorldFeatures, drawProjectilesFX, drawObjectiveArrow,
} from "./arena-draw.mjs";

/** 地面是一整张 WORLD×WORLD 的离屏画布，一局只画一次。 */
export function buildGround(map) {
  const rnd = cosmeticRng(map.seed ^ 0x5bf03635);
  const between = (a, b) => a + rnd() * (b - a);
  const ground = document.createElement("canvas");
  ground.width = WORLD; ground.height = WORLD;
  const c = ground.getContext("2d"), arena = map.mode === "control";
  c.fillStyle = arena ? "#1a3040" : "#2b3143";
  c.fillRect(0, 0, WORLD, WORLD);
  for (let j = 0; j < GRID; j++) for (let i = 0; i < GRID; i++) {
    const x = i * TILE, y = j * TILE, path = (i >= 14 && i <= 16) || (j >= 14 && j <= 16);
    c.fillStyle = arena
      ? (path ? "#213d4a" : (i + j) % 3 ? "#1c3242" : "#1e3545")
      : (path ? "#353c4c" : (i + j) % 3 ? "#2c3243" : "#2d3545");
    c.fillRect(x, y, TILE, TILE);
    line(c, x + 4, y + TILE - 1, x + TILE - 4, y + TILE - 1, "#839faf0b", 1);
    line(c, x + TILE - 1, y + 5, x + TILE - 1, y + TILE - 5, "#839faf0b", 1);
    if ((i * 17 + j * 19) % 11 === 0) { rr(c, x + 9, y + 12, 20, 3, 1, "#799eaa16"); rr(c, x + 9, y + 18, 11, 2, 1, "#799eaa10"); }
  }
  for (let i = 0; i < 1000; i++) {
    c.fillStyle = ["#9dbbc211", "#cceee80d", "#4d809818"][Math.floor(rnd() * 3)];
    c.fillRect(between(0, WORLD), between(0, WORLD), between(1, 3), between(1, 3));
  }
  for (const x of [14 * TILE, 17 * TILE]) {
    line(c, x, 2 * TILE, x, WORLD - 2 * TILE, "#45868129", 2);
    for (let y = 3 * TILE; y < WORLD - 3 * TILE; y += 256) line(c, x, y, x, y + 35, "#61c7b655", 3);
  }
  for (const y of [14 * TILE, 17 * TILE]) {
    line(c, 2 * TILE, y, WORLD - 2 * TILE, y, "#45868129", 2);
    for (let x = 3 * TILE; x < WORLD - 3 * TILE; x += 256) line(c, x, y, x + 35, y, "#61c7b655", 3);
  }
  for (let j = 0; j < GRID; j++) for (let i = 0; i < GRID; i++) {
    if (cell(map, i, j) !== 2) continue;
    const x = i * TILE, y = j * TILE;
    rr(c, x - 2, y - 2, 68, 68, 7, "#162d43"); rr(c, x, y, 64, 64, 5, "#21576d");
    for (let z = 0; z < 5; z++) { const wx = x + between(5, 44), wy = y + between(5, 59); line(c, wx, wy, wx + between(7, 18), wy, "#6cc5dc35", 2); }
  }
  if (arena) for (const [px, py] of [[15.5, 23.5], [15.5, 7.5]]) {
    const col = py > 15 ? "#63efdb" : "#ed88ad";
    ellipse(c, px * TILE, py * TILE, 125, 73, col + "08", col + "26", 2);
    for (let i = -3; i <= 3; i++) line(c, px * TILE + i * 23 - 6, py * TILE + 80, px * TILE + i * 23 + 6, py * TILE + 67, col + "40", 3);
  }
  c.save(); c.translate(WORLD / 2, WORLD / 2); c.globalAlpha = .04; c.rotate(-Math.PI / 2);
  c.font = "900 160px Arial"; c.textAlign = "center"; c.fillStyle = "#b7f5e1";
  c.fillText(arena ? "NEON CIRCUIT" : "DUST / SECTOR", 0, -250);
  c.restore();
  return ground;
}

export function renderGame(ctx, V, ground) {
  if (!ground) return;
  const { view } = S;
  ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
  ctx.clearRect(0, 0, view.w, view.h);
  ctx.fillStyle = "#0d1a2b"; ctx.fillRect(0, 0, view.w, view.h);
  const sx = (Math.random() - .5) * S.shake, sy = (Math.random() - .5) * S.shake;
  ctx.save();
  ctx.translate(view.w / 2 + sx, view.h / 2 + sy);
  ctx.scale(view.zoom, view.zoom);
  ctx.translate(-S.cam.x, -S.cam.y);
  const left = S.cam.x - view.w / (2 * view.zoom) - 100, right = S.cam.x + view.w / (2 * view.zoom) + 100;
  const top = S.cam.y - view.h / (2 * view.zoom) - 130, bottom = S.cam.y + view.h / (2 * view.zoom) + 130;

  ctx.drawImage(ground, 0, 0);
  drawWorldFeatures(ctx, V);
  for (const b of S.map.bushes) {
    if (b.x <= left - 64 || b.x >= right || b.y <= top - 64 || b.y >= bottom) continue;
    const near = V.player && V.player.alive && V.player.x > b.x - 25 && V.player.x < b.x + 89 && V.player.y > b.y - 25 && V.player.y < b.y + 89;
    drawBush(ctx, b.x, b.y, 64, 64, V.time, near ? .72 : 1);
  }
  drawAim(ctx, V);
  for (const cube of V.cubes) {
    if (cube.x < left || cube.x > right || cube.y < top || cube.y > bottom) continue;
    const yy = cube.y - 8 + Math.sin(V.time * 3 + cube.x * .01) * 3;
    ellipse(ctx, cube.x, cube.y + 9, 15, 6, "#5d7d442c");
    ctx.save(); ctx.shadowColor = "#c5ed75"; ctx.shadowBlur = 14;
    poly(ctx, [[cube.x, yy - 14], [cube.x + 12, yy], [cube.x, yy + 15], [cube.x - 12, yy]], "#74efc9", "#648951", 2);
    ctx.restore();
    poly(ctx, [[cube.x, yy - 11], [cube.x + 9, yy], [cube.x, yy + 2], [cube.x - 8, yy]], "#caffea");
    line(ctx, cube.x, yy + 2, cube.x, yy + 12, "#9bc960", 2);
  }
  for (const r of FX.rings) {
    ctx.save(); ctx.globalAlpha = clamp(r.life / r.total, 0, 1);
    const radius = r.max * (1 - r.life / r.total);
    ellipse(ctx, r.x, r.y, radius, radius * .78, null, r.color, 3 + r.life * 4);
    ctx.restore();
  }

  const drawables = [];
  for (const w of S.map.walls) if (w.x > left - 64 && w.x < right && w.y > top - 64 && w.y < bottom) drawables.push({ y: w.y + 58, fn: () => drawWall(ctx, w) });
  for (const b of V.boxes) if (b.x > left && b.x < right && b.y > top && b.y < bottom) drawables.push({ y: b.y + 23, fn: () => drawCrate(ctx, b.x, b.y, 1, b.hp / b.maxHp) });
  for (const a of V.actors) if (a.al && a.x > left && a.x < right && a.y > top && a.y < bottom) drawables.push({ y: a.y + 14, fn: () => drawActor(ctx, V, a) });
  drawables.sort((a, b) => a.y - b.y).forEach(d => d.fn());

  for (const b of V.bullets) {
    ctx.save();
    const color = bulletColor(V, b);
    ctx.strokeStyle = color; ctx.lineWidth = b.r * 2; ctx.lineCap = "round";
    ctx.shadowColor = color; ctx.shadowBlur = b.superShot ? 20 : 9;
    const len = b.superShot ? 32 : 15, speed = Math.hypot(b.vx, b.vy) || 1;
    ctx.beginPath();
    ctx.moveTo(b.x - b.vx / speed * len, b.y - b.vy / speed * len);
    ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.shadowBlur = 0; ctx.lineWidth = b.r * .7; ctx.strokeStyle = "#fffce3"; ctx.stroke();
    ctx.restore();
  }
  drawProjectilesFX(ctx, V);
  for (const p of FX.particles) {
    ctx.globalAlpha = clamp(p.life / p.max, 0, 1);
    rr(ctx, p.x - p.size / 2, p.y - p.size / 2, p.size, p.size, 1, p.color);
  }
  ctx.globalAlpha = 1;
  drawStorm(ctx, V);
  for (const f of FX.floaters) {
    ctx.save(); ctx.globalAlpha = clamp(f.life / .2, 0, 1);
    ctx.font = `900 ${f.big ? 24 : 17}px "Trebuchet MS","Microsoft YaHei",sans-serif`;
    ctx.textAlign = "center"; ctx.lineWidth = 3.5;
    ctx.strokeStyle = "#3a4935"; ctx.strokeText(f.text, f.x, f.y);
    ctx.fillStyle = f.color; ctx.fillText(f.text, f.x, f.y);
    ctx.restore();
  }
  ctx.restore();
  drawObjectiveArrow(ctx, V);
  if (V.player && V.player.al && Math.hypot(V.player.x - V.ring.x, V.player.y - V.ring.y) > V.ring.r) {
    const g = ctx.createRadialGradient(view.w / 2, view.h / 2, view.h * .25, view.w / 2, view.h / 2, view.h * .8);
    g.addColorStop(0, "#7c244100"); g.addColorStop(1, "#97285655");
    ctx.fillStyle = g; ctx.fillRect(0, 0, view.w, view.h);
  }
}

export { drawActor as drawActorSprite, allyTeam };
