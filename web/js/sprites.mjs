/**
 * 手绘矢量精灵。这一整段是从原单机版逐行搬过来的——那些角色、木箱、仙人掌是
 * 一大笔美术资产，重写一遍只会把它弄丢。唯一的改动是把 `HEROS[type]` 换成
 * 从共享数据层 import，让"前端画的样子"与"后端算的数值"同源。
 */

import { TAU } from "/sim/constants.mjs";
import { heroOf } from "/sim/data.mjs";

export function rr(c, x, y, w, h, r = 8, fill, stroke, lw = 2) {
  c.beginPath(); c.roundRect(x, y, w, h, r);
  if (fill) { c.fillStyle = fill; c.fill(); }
  if (stroke) { c.strokeStyle = stroke; c.lineWidth = lw; c.stroke(); }
}

export function ellipse(c, x, y, rx, ry, fill, stroke, lw = 2) {
  c.beginPath(); c.ellipse(x, y, rx, ry, 0, 0, TAU);
  if (fill) { c.fillStyle = fill; c.fill(); }
  if (stroke) { c.strokeStyle = stroke; c.lineWidth = lw; c.stroke(); }
}

export function poly(c, pts, fill, stroke, lw = 2) {
  c.beginPath();
  pts.forEach(([x, y], i) => i ? c.lineTo(x, y) : c.moveTo(x, y));
  c.closePath();
  if (fill) { c.fillStyle = fill; c.fill(); }
  if (stroke) { c.strokeStyle = stroke; c.lineWidth = lw; c.stroke(); }
}

export function line(c, x1, y1, x2, y2, color, width = 2) {
  c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2);
  c.strokeStyle = color; c.lineWidth = width; c.lineCap = "round"; c.stroke();
}

export function drawHero(c, type, x, y, s = 1, angle = 0, walk = 0, flash = 0, scene = false) {
  const h = heroOf(type), ink = "#101b2b";
  c.save(); c.translate(x, y); c.scale(s, s);
  const flip = Math.cos(angle) < 0 ? -1 : 1; c.scale(flip, 1);
  const sway = Math.sin(walk) * 2;
  ellipse(c, 1, 17, type === 1 ? 27 : 22, 8, "#020a1560");
  for (const [bx, dy] of [[-16, sway], [5, -sway]]) {
    rr(c, bx, 1 + dy, 13, 21, 5, "#192735", ink, 2.6);
    rr(c, bx - 1, 13 + dy, 15, 9, 4, "#304052", ink, 2);
    line(c, bx + 2, 18 + dy, bx + 10, 18 + dy, h.color, 2);
    rr(c, bx + 2, 1 + dy, 9, 9, 3, h.dark, ink, 1.5);
  }
  const suit = c.createLinearGradient(-20, -33, 20, 13);
  suit.addColorStop(0, "#35435a"); suit.addColorStop(1, "#1a293b");
  if (type === 0) {
    rr(c, -24, -34, 15, 36, 5, "#334456", ink, 2.5); rr(c, -25, -29, 7, 21, 3, h.color, ink, 1.8);
    rr(c, -19, -31, 39, 41, 11, suit, ink, 3);
    poly(c, [[-19, -28], [-8, -32], [-4, -6], [-13, 2], [-20, -9]], h.color, ink, 2);
    poly(c, [[6, -32], [19, -27], [22, -11], [10, -4]], h.color, ink, 2);
    poly(c, [[-7, -27], [4, -28], [12, -11], [3, -7], [-6, -13]], "#162f3c");
    line(c, -3, -25, 7, -12, "#a7fff0", 2);
    rr(c, -18, 2, 37, 7, 2, "#0e1d2c", ink, 1.4); rr(c, -3, 2, 10, 7, 2, h.color, ink, 1.2);
    rr(c, -17, -59, 35, 34, 12, "#f0c4a6", ink, 2.7);
    poly(c, [[-19, -43], [-24, -61], [-15, -65], [-16, -72], [-6, -69], [5, -77], [11, -68], [23, -63], [23, -47], [17, -39], [13, -53], [-9, -54], [-15, -42]], "#283442", ink, 2.5);
    poly(c, [[-17, -62], [-9, -67], [2, -66], [8, -70], [16, -63]], "#46525e");
    rr(c, -20, -54, 41, 17, 7, "#20434b", ink, 2.2);
    const visor = c.createLinearGradient(-15, -51, 12, -39);
    visor.addColorStop(0, "#b7fff0"); visor.addColorStop(.4, "#5dd8d2"); visor.addColorStop(1, "#3397b2");
    rr(c, -16, -51, 15, 10, 4, visor); rr(c, 3, -51, 14, 10, 4, visor);
    line(c, -12, -48, -6, -48, "#effffc", 1.8); line(c, 6, -48, 12, -48, "#effffc", 1.8);
    poly(c, [[5, -33], [13, -34], [11, -30], [7, -29]], "#834f48");
    line(c, 15, -59, 20, -59, h.color, 3);
    poly(c, [[-18, -30], [-30, -24], [-24, -9], [-10, -18]], "#b46d42", ink, 2);
    rr(c, -26, -25, 12, 10, 4, h.color, ink, 1.8);
    ellipse(c, -20, -7, 7, 8, "#3c4b5b", ink, 2);
    line(c, -24, -11, -17, -11, "#ffd5a0", 2);
  } else if (type === 1) {
    rr(c, -27, -37, 17, 42, 7, "#314d63", ink, 3); rr(c, -22, -34, 48, 47, 12, suit, ink, 3.2);
    poly(c, [[-21, -30], [-8, -35], [-4, -22], [19, -23], [25, -10], [19, 6], [-15, 7], [-23, -9]], h.color, ink, 2.4);
    rr(c, -14, -28, 30, 27, 5, "#203c4b", ink, 2);
    ellipse(c, 1, -15, 10, 10, "#4f8792", ink, 2);
    c.save(); c.shadowColor = "#68ffdf"; c.shadowBlur = 10; ellipse(c, 1, -15, 6.5, 6.5, "#9cffe2"); c.restore();
    ellipse(c, 1, -15, 3, 3, "#effff1");
    rr(c, -25, -65, 49, 35, 10, "#789bad", ink, 3); rr(c, -25, -65, 49, 8, 5, "#aacbcb");
    rr(c, -19, -58, 38, 21, 5, "#193546", ink, 2);
    rr(c, -15, -53, 12, 7, 2, "#b8ffe7"); rr(c, 5, -53, 11, 7, 2, "#b8ffe7");
    line(c, -11, -42, 12, -42, "#4d7b88", 2);
    rr(c, -28, -53, 6, 13, 2, h.dark, ink, 1.5); rr(c, 22, -54, 6, 15, 2, h.dark, ink, 1.5);
    line(c, -1, -67, -1, -72, ink, 3); ellipse(c, -1, -75, 4, 4, "#ffbd8d", ink, 1.4);
    rr(c, -33, -28, 19, 23, 7, "#93c8c8", ink, 2.5); rr(c, -29, -9, 14, 18, 5, "#2f5261", ink, 2.2);
    line(c, -29, -22, -18, -22, "#d2ffeb", 2.5);
    [-17, 20].forEach(b => { ellipse(c, b, -29, 2, 2, "#1d384a"); ellipse(c, b, 7, 2, 2, "#1d384a"); });
  } else if (type === 2) {
    poly(c, [[-20, -32], [21, -28], [28, 21], [8, 12], [-23, 20]], "#4d426e", ink, 2.6);
    poly(c, [[-20, -28], [-15, 16], [-8, 4], [-12, -25]], "#8c7bbb");
    line(c, -18, 7, -16, 14, "#bea1fd", 2);
    rr(c, -16, -30, 34, 39, 9, suit, ink, 2.5);
    poly(c, [[-14, -28], [-8, -31], [15, -7], [10, 1]], "#a88cdc", ink, 1.5);
    rr(c, -14, 3, 30, 7, 2, "#253145", ink, 1.4); rr(c, -3, 3, 8, 7, 2, "#ac95de");
    poly(c, [[-22, -38], [-21, -60], [-8, -74], [7, -77], [25, -61], [25, -38], [14, -25], [-13, -26]], "#8b7ab9", ink, 2.9);
    poly(c, [[-22, -55], [-8, -70], [7, -73], [17, -63], [-4, -66]], "#b1a0d5");
    poly(c, [[-15, -45], [-8, -58], [10, -58], [18, -44], [12, -31], [-9, -31]], "#202d44", ink, 2);
    line(c, -10, -46, -1, -45, "#a4ffeb", 3); line(c, 5, -45, 14, -47, "#a4ffeb", 3);
    poly(c, [[-13, -33], [15, -33], [10, -26], [-10, -27]], "#564570", ink, 1.8);
    rr(c, -23, -20, 13, 25, 6, "#756296", ink, 2.4); rr(c, -23, -3, 14, 10, 4, "#28354a", ink, 2);
    line(c, -19, -15, -14, -9, "#c6b0f6", 2);
  } else {
    rr(c, -24, -35, 14, 36, 6, "#785a8b", ink, 2.5); rr(c, -18, -33, 38, 44, 10, suit, ink, 2.8);
    poly(c, [[-18, -30], [-5, -35], [4, -16], [-5, 3], [-20, -7]], "#ebd8e6", ink, 2);
    poly(c, [[5, -31], [18, -29], [22, -10], [10, 7], [2, 4]], h.color, ink, 2);
    rr(c, -11, -21, 20, 17, 5, "#4b3a68", ink, 1.8);
    ellipse(c, -1, -12, 5, 5, "#fcaada");
    line(c, -5, -12, 3, -12, "#fff1fe", 1.6); line(c, -1, -16, -1, -8, "#fff1fe", 1.6);
    rr(c, -14, 3, 31, 7, 2, "#836087", ink, 1.5);
    rr(c, -18, -64, 36, 36, 12, "#e1e5f0", ink, 2.8);
    poly(c, [[-20, -45], [-23, -60], [-13, -72], [2, -76], [17, -65], [22, -48], [14, -43], [10, -59], [-5, -60], [-13, -43]], "#f3eaf4", ink, 2.6);
    poly(c, [[-4, -69], [5, -71], [16, -62], [14, -57]], "#f49bc6");
    rr(c, -19, -51, 37, 17, 7, "#302843", ink, 1.8);
    line(c, -13, -44, -4, -43, "#ffbeef", 3); line(c, 4, -43, 12, -45, "#ffbeef", 3);
    rr(c, -25, -53, 8, 18, 3, h.color, ink, 1.6);
    ellipse(c, 21, -53, 8, 9, "#845a88", ink, 2); ellipse(c, 21, -53, 4, 4, "#ffcee8");
    rr(c, -28, -25, 14, 25, 6, "#e4cedd", ink, 2.4); rr(c, -27, -10, 13, 18, 5, h.color, ink, 2);
    line(c, -23, -7, -19, -7, "#ffe9fa", 2);
  }
  let localAngle = Math.atan2(Math.sin(angle), Math.abs(Math.cos(angle)));
  if (scene) localAngle = -.10;
  c.save(); c.translate(type === 1 ? 17 : 12, -12); c.rotate(localAngle * .65);
  ellipse(c, 1, 0, 7, 7, type === 0 ? "#d7ad98" : h.light, ink, 2);
  if (type === 0) { rr(c, 4, -10, 32, 15, 4, "#cadbdd", ink, 2.6); rr(c, 24, -8, 15, 12, 3, "#325569", ink, 2); rr(c, 10, 4, 9, 10, 3, "#223a4f", ink, 1.8); line(c, 9, -5, 22, -5, "#a1ffe6", 2.7); rr(c, 34, -5, 7, 7, 1, "#81d2ce", ink, 1.5); }
  if (type === 1) { rr(c, 3, -13, 32, 25, 6, "#254353", ink, 2.8); rr(c, 23, -15, 18, 29, 5, "#90b3bb", ink, 2.4); rr(c, 31, -10, 11, 8, 2, "#142a3b"); rr(c, 31, 2, 11, 8, 2, "#142a3b"); line(c, 8, -7, 19, -7, "#6cf3dc", 2.6); line(c, 8, 4, 19, 4, "#6cf3dc", 2.6); }
  if (type === 2) { rr(c, 2, -8, 36, 15, 4, "#bbb3d5", ink, 2.4); rr(c, 32, -5, 28, 8, 2, "#415870", ink, 2); rr(c, 58, -7, 9, 12, 2, "#939fbc", ink, 1.8); rr(c, 11, -16, 17, 8, 3, "#426672", ink, 2); line(c, 13, -12, 21, -12, "#9effe7", 2); rr(c, 7, 4, 10, 12, 3, "#5d4e76", ink, 1.7); line(c, 36, -1, 53, -1, "#c6a1ff", 2.2); }
  if (type === 3) { rr(c, 4, -10, 26, 19, 6, "#b4c5d3", ink, 2.5); rr(c, 17, -14, 15, 27, 5, "#9c6ba4", ink, 2); ellipse(c, 33, -1, 10, 12, "#392d5a", ink, 2); c.save(); c.shadowColor = "#ffbee9"; c.shadowBlur = flash > 0 ? 15 : 5; ellipse(c, 36, -1, 5, 7, "#ffb7e7"); c.restore(); line(c, 10, -5, 14, -5, "#ffddf2", 2); }
  if (flash > 0) { const end = type === 2 ? 71 : type === 1 ? 46 : 43; poly(c, [[end, -2], [end + 10, -11], [end + 8, -3], [end + 23, 0], [end + 8, 4], [end + 11, 12], [end, 7]], type === 3 ? "#ffd2f1" : "#fff5bd"); }
  c.restore();
  if (type === 3 && scene) { const yy = -47 + Math.sin(walk) * 2; ellipse(c, -42, yy, 9, 7, "#475069", ink, 1.5); line(c, -47, yy, -37, yy, "#ffd1f4", 2); ellipse(c, -42, yy + 12, 8, 2, "#c5a3ec25"); }
  c.restore();
}

export function drawCrate(c, x, y, s = 1, hp = 1) {
  c.save(); c.translate(x, y); c.scale(s, s);
  ellipse(c, 3, 28, 31, 11, "#030c194f");
  rr(c, -26, -19, 52, 46, 6, "#263e51", "#102336", 2);
  rr(c, -27, -27, 54, 46, 6, "#516877", "#1b3448", 2.4);
  rr(c, -20, -20, 40, 32, 3, "#294759", "#1c344b", 1.6);
  poly(c, [[-21, -20], [-14, -20], [21, 5], [21, 12], [13, 12], [-21, -12]], "#537786");
  rr(c, -26, -26, 52, 7, 2, "#6d8a90", "#20394c", 1);
  rr(c, -27, 12, 54, 8, 2, "#39576b", "#20394c", 1);
  for (const xx of [-21, 21]) { ellipse(c, xx, -22, 2, 2, "#203448"); ellipse(c, xx, 16, 2, 2, "#1a3045"); }
  poly(c, [[0, -15], [10, -3], [0, 10], [-10, -3]], "#8cf6d2", "#153b48", 2);
  poly(c, [[0, -11], [6, -3], [0, 0], [-6, -3]], "#deffea");
  line(c, -18, 23, -9, 23, "#6195a4", 2); line(c, 9, 23, 18, 23, "#6195a4", 2);
  if (hp < .999) { rr(c, -25, -36, 50, 5, 2, "#091c30"); rr(c, -24, -35, 48 * Math.max(0, Math.min(1, hp)), 3, 1, "#fed393"); }
  c.restore();
}

export function drawBush(c, x, y, w, h, t = 0, alpha = 1) {
  c.save(); c.globalAlpha = alpha;
  rr(c, x + 3, y + 5, w - 6, h - 6, 10, "#23595850");
  for (let j = 0; j < 3; j++) for (let i = 0; i < 4; i++) {
    const px = x + 10 + i * 13 + (j % 2) * 3, py = y + 17 + j * 17;
    const sway = Math.sin(t * 1.3 + px * .04 + py * .02) * 1.8;
    poly(c, [[px - 7, py + 11], [px - 8 + sway, py - 3], [px - 1 + sway, py - 10], [px + 2, py - 2], [px + 7 + sway, py - 8], [px + 8, py + 8]], j === 2 ? "#327e78" : "#2b706e", "#225653", 1);
    line(c, px, py + 6, px + sway, py - 6, j === 2 ? "#56a998" : "#489386", 1.2);
  }
  c.restore();
}

export function drawWall(c, w) {
  const { x, y } = w;
  const top = w.border ? "#2a3c52" : "#3b5569", side = w.border ? "#192d42" : "#233c52", edge = "#1a3045";
  rr(c, x + 6, y + 10, 64, 64, 6, "#030c194d");
  rr(c, x + 1, y - 2, 62, 71, 5, side, edge, 2);
  rr(c, x + 1, y - 13, 62, 70, 6, top, edge, 2);
  rr(c, x + 6, y - 9, 52, 8, 3, w.border ? "#3c5368" : "#527889");
  line(c, x + 7, y + 43, x + 56, y + 43, "#37596b", 2);
  line(c, x + 31, y + 17, x + 31, y + 42, "#1b354743", 1.5);
  line(c, x + 4, y + 16, x + 58, y + 16, "#87b7c114", 1.5);
  if (!w.border && (w.tx + w.ty) % 3 === 0) { line(c, x + 11, y + 2, x + 27, y + 2, "#77d4c6", 2); line(c, x + 34, y + 2, x + 48, y + 2, "#486a7b", 2); }
  if (!w.border && (w.tx * 17 + w.ty) % 5 === 0) poly(c, [[x + 43, y + 23], [x + 50, y + 23], [x + 43, y + 35], [x + 36, y + 35]], "#d0a97990");
}
