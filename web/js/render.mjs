/**
 * 主渲染：地面、场景物件、单位、子弹、风暴、跳字。
 *
 * 逐行移植自原单机版，唯一的结构性变化是"所有输入都从 V（视图对象）来"，
 * 而不是读一堆模块级全局变量。这样同一段画法既能画权威快照，也能画预测位置，
 * 而且再也不会出现"改了一个全局变量，另一个界面莫名其妙跟着变"。
 */

import { TAU, TILE, GRID, WORLD, clamp, lerp } from "/sim/constants.mjs";
import { heroOf } from "/sim/data.mjs";
import { cell } from "/sim/map.mjs";
import { cosmeticRng } from "/sim/rng.mjs";
import { rr, ellipse, poly, line, drawHero, drawCrate, drawBush, drawWall } from "./sprites.mjs";
import { FX, S } from "./state.mjs";

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

const allyTeam = (V, team) => V.mode === "control" && V.player && team === V.player.tm;

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

function bulletColor(V, b) {
  if (allyTeam(V, b.team)) return b.superShot ? "#ffe7a3" : b.hero === 3 ? "#ffc0f1" : "#80ffdf";
  return b.superShot ? "#ffb983" : "#ff819c";
}

function drawStorm(ctx, V) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(-400, -400, WORLD + 800, WORLD + 800);
  ctx.arc(V.ring.x, V.ring.y, V.ring.r, 0, TAU, true);
  ctx.clip("evenodd");
  ctx.fillStyle = "#713d7771";
  ctx.fillRect(-400, -400, WORLD + 800, WORLD + 800);
  const gap = 95, off = (V.time * 12) % gap;
  for (let k = -20; k < 45; k++) line(ctx, k * gap + off, -300, k * gap + off - 1000, WORLD + 300, "#b6e09310", 18);
  ctx.restore();
  if (V.ring.r < 1400) {
    ctx.save(); ctx.setLineDash([15, 12]); ctx.lineDashOffset = -V.time * 14;
    ellipse(ctx, V.ring.x, V.ring.y, V.ring.r, V.ring.r, null, "#75eed7aa", 4);
    ctx.setLineDash([]);
    ellipse(ctx, V.ring.x, V.ring.y, V.ring.r + 8, V.ring.r + 8, null, "#6697b344", 12);
    ctx.restore();
  }
}

export function drawActor(ctx, V, a) {
  if (!a.al) return;
  const me = V.player && a.i === V.player.i;
  const ally = allyTeam(V, a.tm);
  const hidden = cell(S.map, Math.floor(a.x / TILE), Math.floor(a.y / TILE)) === 3 && !a.hf;
  ctx.save();
  if (hidden) ctx.globalAlpha = me ? .62 : .50;
  ellipse(ctx, a.x, a.y + 9, me ? 30 : 27, me ? 14 : 12,
    me ? "#63ffe330" : ally ? "#56efd318" : "#f973991c",
    me ? "#61eed2" : ally ? "#5fedd5aa" : "#ff889daa", me ? 2.5 : 1.7);
  if (a.dk) { ctx.globalAlpha *= .20; drawHero(ctx, a.h, a.x, a.y, .95, a.angle, a.wl * 11, 0); ctx.globalAlpha = hidden ? .62 : 1; }
  drawHero(ctx, a.h, a.x, a.y, .93, a.angle, a.wl * 11, a.fl);
  if (a.hf) ellipse(ctx, a.x, a.y - 17, 23, 29, "#fff4cf50");
  if (a.sh > 0) ellipse(ctx, a.x, a.y - 20, 34, 45, "#d7f8eb10", "#d7f8eb94", 2);
  ctx.globalAlpha = 1;
  const barY = a.y - 79;
  rr(ctx, a.x - 29, barY, 58, 7, 3, "#293b31", "#e4e5b67f", .8);
  rr(ctx, a.x - 28, barY + 1, 56 * clamp(a.hp / a.mh, 0, 1), 5, 2, ally || me ? "#62efd3" : "#ff819a");
  ctx.textAlign = "center";
  ctx.font = '700 11px "Trebuchet MS","Microsoft YaHei",sans-serif';
  ctx.lineWidth = 3; ctx.strokeStyle = "#384337"; ctx.fillStyle = me ? "#f0ffd5" : "#fff2d5";
  const label = me ? "你" : ally ? "队友 · " + a.n : a.n;
  ctx.strokeText(label, a.x, barY - 8); ctx.fillText(label, a.x, barY - 8);
  if (a.cu) { ctx.font = "800 10px Arial"; ctx.fillStyle = "#d5ff9c"; ctx.strokeText("◆ " + a.cu, a.x, barY - 23); ctx.fillText("◆ " + a.cu, a.x, barY - 23); }
  if (me && a.am !== undefined) for (let i = 0; i < 3; i++) {
    rr(ctx, a.x - 26 + i * 18, barY + 10, 16, 4, 2, "#63583780");
    rr(ctx, a.x - 26 + i * 18, barY + 10, 16 * clamp(a.am - i, 0, 1), 4, 2, "#ffe095");
  }
  ctx.restore();
}

export function drawAim(ctx, V) {
  const p = V.player;
  if (!p || !p.al) return;
  const h = heroOf(p.h);
  const show = S.mouse.known || S.touch.aim.active;
  if (!show) return;
  ctx.save(); ctx.translate(p.x, p.y - 9); ctx.rotate(p.angle);
  const len = Math.min(h.range, 570);
  let blocked = len;
  for (let d = 30; d < len; d += 12) {
    if (cell(S.map, Math.floor((p.x + Math.cos(p.angle) * d) / TILE), Math.floor((p.y - 9 + Math.sin(p.angle) * d) / TILE)) === 1) { blocked = d; break; }
  }
  const width = p.h === 1 ? Math.min(90, blocked * .23) : p.h === 2 ? 6 : 15;
  const grad = ctx.createLinearGradient(22, 0, blocked, 0);
  grad.addColorStop(0, "#fff8cb03");
  grad.addColorStop(1, (p.su || 0) >= 100 ? "#fff9a638" : "#fff9d72b");
  poly(ctx, [[24, -5], [blocked, -width], [blocked, width], [24, 5]], grad);
  ctx.setLineDash([7, 9]); line(ctx, 36, 0, blocked, 0, "#fff5ce99", 1.5); ctx.setLineDash([]);
  line(ctx, blocked, -width, blocked, width, "#fff4c77a", 2);
  ctx.restore();
}

export function drawWorldFeatures(ctx, V) {
  if (V.mode === "control") {
    const z = V.zone;
    const color = z.ct ? "#f0c17d" : z.ow === 1 ? "#ff809d" : "#67f6db";
    ctx.save();
    const glow = ctx.createRadialGradient(z.x, z.y, 20, z.x, z.y, z.r);
    glow.addColorStop(0, color + "18"); glow.addColorStop(1, color + "08");
    ellipse(ctx, z.x, z.y, z.r, z.r, glow, color + "c0", 3);
    ctx.setLineDash([13, 11]); ctx.lineDashOffset = -V.time * 12;
    ellipse(ctx, z.x, z.y, z.r + 8, z.r + 8, null, color + "44", 2);
    ctx.setLineDash([]);
    ctx.translate(z.x, z.y); ctx.rotate(V.time * .16);
    for (let k = 0; k < 6; k++) { ctx.rotate(TAU / 6); line(ctx, z.r - 9, 0, z.r + 3, 0, color, 4); }
    ctx.rotate(-V.time * .16);
    poly(ctx, [[0, -37], [32, -18], [32, 18], [0, 37], [-32, 18], [-32, -18]], color + "10", color + "77", 2);
    ellipse(ctx, 0, 0, 12, 12, null, color + "aa", 2);
    ctx.font = "700 12px Arial"; ctx.textAlign = "center"; ctx.fillStyle = color;
    ctx.fillText(z.ct ? "CONTESTED" : z.ow === 0 ? "CAPTURING" : "HOT ZONE", 0, 67);
    ctx.restore();
  }
  for (const f of V.fields) {
    const ally = allyTeam(V, f.team);
    const color = ally ? "#e5abff" : "#ff87b8";
    ctx.save();
    ellipse(ctx, f.x, f.y, f.r, f.r, color + "12", color + "80", 2);
    ctx.setLineDash([8, 15]); ctx.lineDashOffset = V.time * 17;
    ellipse(ctx, f.x, f.y, f.r - 10, f.r - 10, null, color + "88", 3);
    ctx.setLineDash([]);
    for (let i = 0; i < 5; i++) {
      const ang = V.time * .55 + i * TAU / 5;
      const x = f.x + Math.cos(ang) * f.r * .62, y = f.y + Math.sin(ang) * f.r * .62;
      line(ctx, x - 7, y, x + 7, y, color + "70", 2);
      line(ctx, x, y - 7, x, y + 7, color + "70", 2);
    }
    ctx.restore();
  }
  for (const g of V.grenades) {
    const pct = clamp((V.time - (g.at - .8)) / .8, 0, 1);
    const color = allyTeam(V, V.mode === "control" && V.player && V.player.tm === V.player.tm ? 0 : -1) ? "#c5a8ff" : "#ff8da9";
    ellipse(ctx, g.x, g.y, g.r, g.r, color + "0f", color + "55", 1.5);
    ctx.save(); ctx.setLineDash([9, 8]);
    ellipse(ctx, g.x, g.y, g.r * pct, g.r * pct, null, color + "aa", 2);
    ctx.restore();
  }
  for (const s of V.supplies) {
    const incoming = s.state === "incoming", color = "#b9a1ff";
    ctx.save();
    ellipse(ctx, s.x, s.y, 42, 28, color + "12", color + "60", 2);
    if (incoming) {
      ctx.setLineDash([8, 9]); ellipse(ctx, s.x, s.y, 65, 65, null, color + "77", 2); ctx.setLineDash([]);
      const y = s.y - 40 - clamp((s.at - V.time) / 3.2, 0, 1) * 180;
      line(ctx, s.x, y, s.x, s.y, color + "3b", 2);
      rr(ctx, s.x - 21, y - 20, 42, 31, 6, "#42385d", color, 2);
      poly(ctx, [[s.x - 34, y - 38], [s.x + 34, y - 38], [s.x + 22, y - 25], [s.x - 22, y - 25]], "#8876b4", color, 1.5);
      line(ctx, s.x - 38, y - 38, s.x - 52, y - 38, color, 2);
      line(ctx, s.x + 38, y - 38, s.x + 52, y - 38, color, 2);
      ctx.textAlign = "center"; ctx.font = "700 11px Arial"; ctx.fillStyle = "#e4d7ff";
      ctx.fillText("DROP / " + Math.max(1, Math.ceil(s.at - V.time)), s.x, s.y + 47);
    } else {
      const y = s.y - 12 + Math.sin(V.time * 2.8) * 4;
      ctx.shadowColor = color; ctx.shadowBlur = 18;
      rr(ctx, s.x - 22, y - 20, 44, 40, 8, "#665a85", "#c6b2ff", 2);
      ctx.shadowBlur = 0;
      poly(ctx, [[s.x, y - 12], [s.x + 9, y], [s.x, y + 12], [s.x - 9, y]], "#ead7ff");
      ctx.textAlign = "center"; ctx.font = "700 10px Arial"; ctx.fillStyle = "#dbccff";
      ctx.fillText("OVERDRIVE", s.x, s.y + 45);
    }
    ctx.restore();
  }
}

export function drawProjectilesFX(ctx, V) {
  for (const b of FX.beams) {
    ctx.save(); ctx.globalAlpha = clamp(b.life / .18, 0, 1);
    ctx.shadowColor = b.color; ctx.shadowBlur = 12;
    const mx = lerp(b.x, b.ex, .45) + 12, my = lerp(b.y, b.ey, .45) - 8;
    line(ctx, b.x, b.y, mx, my, b.color, 4);
    line(ctx, mx, my, b.ex, b.ey, b.color, 4);
    ctx.restore();
  }
  for (const g of V.grenades) {
    const t = clamp((V.time - (g.at - .8)) / .8, 0, 1);
    const x = lerp(g.sx, g.x, t), y = lerp(g.sy, g.y, t) - Math.sin(t * Math.PI) * 110;
    ctx.save(); ctx.translate(x, y); ctx.rotate(t * 9);
    rr(ctx, -9, -9, 18, 18, 4, "#c9b0ee", "#f6deff", 2);
    line(ctx, -5, 0, 5, 0, "#fff3db", 2);
    ctx.restore();
  }
}

export function drawObjectiveArrow(ctx, V) {
  const p = V.player;
  if (!p || !p.al || V.phase === "over") return;
  let point = V.mode === "control" ? V.zone : null, kind = "热点", color = "#7effe1";
  if (V.mode === "survival" && Math.hypot(p.x - V.ring.x, p.y - V.ring.y) > V.ring.r - 60) { point = V.ring; kind = "安全区"; }
  if (!point) return;
  const x = (point.x - S.cam.x) * S.view.zoom + S.view.w / 2;
  const y = (point.y - S.cam.y) * S.view.zoom + S.view.h / 2;
  if (x > 125 && x < S.view.w - 125 && y > 150 && y < S.view.h - 220) return;
  const angle = Math.atan2(y - S.view.h / 2, x - S.view.w / 2);
  const rx = S.view.w * .5 - 65, ry = S.view.h * .5 - 150;
  if (ry < 35) return;
  const t = Math.min(rx / Math.max(.001, Math.abs(Math.cos(angle))), ry / Math.max(.001, Math.abs(Math.sin(angle))));
  const ax = S.view.w / 2 + Math.cos(angle) * t, ay = S.view.h / 2 + Math.sin(angle) * t;
  ctx.save(); ctx.translate(ax, ay); ctx.rotate(angle);
  poly(ctx, [[13, 0], [-7, -9], [-2, 0], [-7, 9]], color, "#143331", 1);
  ctx.rotate(-angle);
  ctx.font = '700 10px "Microsoft YaHei",sans-serif';
  ctx.textAlign = "center"; ctx.fillStyle = color;
  ctx.shadowColor = "#061722"; ctx.shadowBlur = 6;
  ctx.fillText(kind, 0, 25);
  ctx.restore();
}
