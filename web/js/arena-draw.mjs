/**
 * 竞技场的"画法"：单位、准星、热点、空投、子弹与风暴。
 *
 * 从 `render.mjs` 里拆出来的：那边只管"什么时候画、画在哪"（相机、排序、裁剪），
 * 这边只管"长什么样"。所有输入都从 V（视图对象）来，不读模块级全局——
 * 于是同一段画法既能画权威快照，也能画预测位置。
 */

import { TAU, TILE, WORLD, clamp, lerp } from "/sim/constants.mjs";
import { heroOf } from "/sim/data.mjs";
import { cell } from "/sim/map.mjs";
import { rr, ellipse, poly, line, drawHero } from "./sprites.mjs";
import { FX, S } from "./state.mjs";

const allyTeam = (V, team) => V.mode === "control" && V.player && team === V.player.tm;

function bulletColor(V, b) {
  if (allyTeam(V, b.team)) return b.superShot ? "#ffe7a3" : b.hero === 3 ? "#ffc0f1" : "#80ffdf";
  return b.superShot ? "#ffb983" : "#ff819c";
}

export function drawStorm(ctx, V) {
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

export { bulletColor, allyTeam };
