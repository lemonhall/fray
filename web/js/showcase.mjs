/**
 * 候场页的立绘舞台 + 作战配置面板（英雄 / 战术装置 / 生涯）。
 *
 * 画法逐行来自原版单机版的大厅立绘：那套矢量角色是原作者的资产，重写只会画得更差，
 * 所以这里只把"输入从哪来、往哪去"改掉——选谁不再是一次性的本地开局参数，
 * 而是一条会发给服务端的消息（`{t:"hero"}`）。
 */

import { HEROS, GADGETS, heroOf } from "/sim/data.mjs";
import { ellipse, poly, line, drawHero } from "./sprites.mjs";
import { S } from "./state.mjs";

const $ = id => document.getElementById(id);
const readLocal = key => { try { return localStorage.getItem(key); } catch { return null; } };
const writeLocal = (key, value) => { try { localStorage.setItem(key, value); } catch { /* 隐私模式 */ } };

/** 生涯档案只存在浏览器本地——它是个人的战绩纪念册，不是权威数据。 */
export const career = {
  load() {
    let data = {};
    try { data = JSON.parse(readLocal("fray.career") || "{}") || {}; } catch { data = {}; }
    return { games: 0, wins: 0, best: 11, xp: 0, hero: 0, gadget: "grenade", ...data };
  },
  save(next) { writeLocal("fray.career", JSON.stringify(next)); },
};

let prefs = career.load();
let selected = Number.isFinite(prefs.hero) ? prefs.hero : 0;
let hooks = {};

const reduced = () => matchMedia("(prefers-reduced-motion:reduce)").matches;

export const selectedHero = () => selected;
export const prefsOf = () => prefs;

export function updateCareer() {
  const level = Math.floor(prefs.xp / 500) + 1;
  $("accountLevel").textContent = "LV." + String(level).padStart(2, "0");
  $("careerFill").style.width = (prefs.xp % 500) / 5 + "%";
  $("recordLabel").textContent = prefs.games ? `${prefs.wins} 胜 / ${prefs.games} 场` : "新的征程";
}

export function addCareer({ xp = 0, win = false }) {
  prefs.games++; prefs.xp += xp; if (win) prefs.wins++;
  career.save({ ...prefs, hero: selected });
  updateCareer();
}

/** 只改本地选择与面板文案；是否要告诉服务端由 onChange 决定。 */
export function selectHero(i) {
  selected = Math.max(0, Math.min(HEROS.length - 1, Math.floor(i)));
  const h = HEROS[selected];
  $("heroRole").textContent = h.role;
  $("heroName").innerHTML = `${h.name}<span>${h.en}</span>`;
  $("stageHeroName").textContent = h.en;
  const index = document.querySelector(".stage-index");
  if (index) index.textContent = `0${selected + 1} / 04`;
  $("heroDescription").textContent = h.description;
  $("superName").textContent = h.superName;
  $("superDescription").textContent = h.superDescription;
  ["statHealth", "statDamage", "statRange"].forEach((id, j) => { $(id).style.width = h.stats[j] + "%"; });
  const counter = document.querySelector(".panel-counter");
  if (counter) counter.textContent = `0${selected + 1} — 04`;
  document.querySelectorAll(".hero-option").forEach((el, j) => {
    el.classList.toggle("selected", j === selected);
    el.setAttribute("aria-pressed", String(j === selected));
  });
  career.save({ ...prefs, hero: selected });
}

function chooseGadget(id) {
  if (!GADGETS[id]) return;
  prefs.gadget = id;
  career.save({ ...prefs, hero: selected, gadget: id });
  document.querySelectorAll("[data-gadget]").forEach(el => {
    const on = el.dataset.gadget === id;
    el.classList.toggle("selected", on);
    el.setAttribute("aria-pressed", String(on));
  });
  $("gadgetDescription").textContent = GADGETS[id].description;
  hooks.onGadget?.(id);
}

/** 大厅里的"作战配置"面板：选谁、带什么装置。 */
export function initLoadout(next = {}) {
  hooks = next;
  document.querySelectorAll(".hero-option").forEach(el => {
    const canvas = el.querySelector("canvas");
    const i = Number(el.dataset.hero);
    const c = canvas.getContext("2d");
    c.clearRect(0, 0, canvas.width, canvas.height);
    drawHero(c, i, 57, 102, 1.28, -.1, 0, 0, true);
    el.addEventListener("click", () => { selectHero(i); hooks.onHero?.(i); });
  });
  document.querySelectorAll("[data-gadget]").forEach(el => {
    el.addEventListener("click", () => chooseGadget(el.dataset.gadget));
  });
  selectHero(selected);
  chooseGadget(GADGETS[prefs.gadget] ? prefs.gadget : "grenade");
  updateCareer();
}

export function drawPortrait(canvas, type = selected, big = false) {
  const c = canvas.getContext("2d");
  c.clearRect(0, 0, canvas.width, canvas.height);
  if (big) drawHero(c, type, 39, 83, 1.04, -.1, 0, 0, true);
  else drawHero(c, type, canvas.width / 2, canvas.height - 3, .34, -.1, 0, 0, true);
}

const showcase = () => $("showcase");

function resizeShowcase() {
  const canvas = showcase();
  const box = $("lobby").getBoundingClientRect();
  if (!box.width) return;
  canvas.width = Math.round(box.width * S.dpr);
  canvas.height = Math.round(box.height * S.dpr);
  canvas.style.width = box.width + "px";
  canvas.style.height = box.height + "px";
}

/** 每帧调用一次（只在大厅可见时）。t 用秒，用来做浮动与光晕的呼吸。 */
export function renderShowcase(t) {
  const canvas = showcase();
  if (!canvas || $("lobby").classList.contains("hidden")) return;
  if (!canvas.width) resizeShowcase();
  const w = canvas.width / S.dpr, h = canvas.height / S.dpr;
  const c = canvas.getContext("2d");
  c.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
  c.clearRect(0, 0, w, h);
  const mobile = w <= 900;
  const rect = document.querySelector(".stage-space").getBoundingClientRect();
  const x = mobile ? (w >= 620 && innerHeight > 600 ? w * .235 : w * .805) : rect.left + rect.width / 2;
  const y = mobile ? (w >= 620 && innerHeight > 600 ? 480 : 292) : rect.top + rect.height * .615;
  const scale = mobile ? (w >= 620 ? 1.75 : 1.42) : Math.min(rect.width / 140, (h - 110) / 225, 3.65);
  const hero = heroOf(selected);
  const float = reduced() ? 0 : Math.sin(t * 1.6) * 1.6;
  c.save();
  c.translate(x, y);
  c.scale(scale, scale);
  const halo = c.createRadialGradient(0, -27, 9, 0, -27, 89);
  halo.addColorStop(0, hero.color + "18");
  halo.addColorStop(.55, "#65dfd407");
  halo.addColorStop(1, "#65dfd400");
  c.fillStyle = halo;
  c.fillRect(-110, -135, 220, 215);
  if (!mobile) {
    c.save();
    c.translate(0, -32); c.rotate(-.24);
    ellipse(c, 0, 0, 71, 71, null, "#79d2c215", .6);
    c.setLineDash([.8, 5]); ellipse(c, 0, 0, 77, 77, null, "#86f4dc24", 1); c.setLineDash([]);
    c.rotate(t * .12);
    for (let i = 0; i < 4; i++) { c.rotate(Math.PI / 2); line(c, 69, -7, 69, 7, "#a0edd944", 1.3); }
    c.restore();
  }
  ellipse(c, 2, 34, 62, 21, "#020a1675");
  poly(c, [[-62, 9], [-40, -9], [38, -9], [65, 9], [65, 23], [38, 43], [-39, 43], [-62, 25]], "#122537", "#102033", 1.5);
  poly(c, [[-62, 9], [-39, 29], [38, 29], [65, 9], [65, 23], [38, 43], [-39, 43], [-62, 25]], "#1d3847", "#102435", 1.2);
  poly(c, [[-62, 9], [-40, -9], [38, -9], [65, 9], [38, 29], [-39, 29]], "#31505b", "#66a29855", 1);
  line(c, -53, 17, -38, 28, "#57e0c2", 1.8); line(c, -36, 32, 6, 32, "#62dac2", 1.4);
  line(c, 38, 32, 58, 17, "#57e0c2", 1.8); line(c, -34, 36, -20, 36, "#407077", 1.2);
  line(c, 13, 36, 26, 36, "#407077", 1.2);
  ellipse(c, 0, 7, 45, 17, "#182e3b", "#62baae55", .8);
  ellipse(c, 0, 7, 38, 13, null, "#88ffdc50", 1);
  c.save(); c.translate(0, 7); c.scale(1, .34); c.rotate(t * .23);
  c.setLineDash([9, 20]); ellipse(c, 0, 0, 42, 42, null, "#91ffe680", 2); c.restore();
  for (let i = 0; i < 7; i++) {
    const ang = i * 4.7;
    ellipse(c, Math.sin(ang) * 49, Math.cos(ang) * 9 + 9, .8, .45, "#aaffdb55");
  }
  c.save(); c.translate(0, float); drawHero(c, selected, -3, 3, 1.24, -.1, t, 0, true); c.restore();
  if (!mobile) {
    for (let i = 0; i < 12; i++) {
      const ang = i * 4.61;
      const px = Math.sin(ang) * 69, py = -40 + Math.cos(ang * .7) * 66 + Math.sin(t * .6 + i) * 2;
      ellipse(c, px, py, i % 4 === 0 ? .75 : .4, i % 4 === 0 ? .75 : .4, "#9dedce5c");
    }
    c.font = "600 2.5px Arial"; c.fillStyle = "#7aafad"; c.textAlign = "left";
    c.fillText("SYNC // 100%", -75, -47);
    line(c, -64, -43, -56, -43, "#7ad8c588", .5);
    line(c, 54, -60, 65, -60, "#7ad8c566", .5);
    c.fillText("FIELD READY", 54, -64);
  }
  c.restore();
}

export { resizeShowcase };
