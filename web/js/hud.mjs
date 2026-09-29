/**
 * HUD：把一帧视图对象（V）映射到 DOM。
 *
 * 这个模块只**读** V 和 S，不碰网络也不碰模拟。它存在的原因很实际：原版的 HUD 是
 * 直接读一堆全局变量的，搬到联机版之后"谁的数据"变得很关键——血条读的是
 * **最新快照里我自己的实体**，而不是本地预测的位置。判定在服务端，界面就得显示判定。
 */

import { WORLD, TILE, clamp, clock } from "/sim/constants.mjs";
import { GADGETS, ZONE_POINTS, MODES, heroOf } from "/sim/data.mjs";
import { contractsOf } from "/sim/flow.mjs";
import { ellipse, poly } from "./sprites.mjs";
import { drawPortrait } from "./showcase.mjs";
import { FX, S } from "./state.mjs";

const $ = id => document.getElementById(id);
const mini = () => $("minimap").getContext("2d");
let lastHud = -1;

/** 大招 / 闪避 / 装置的冷却快照，用来画按钮上的扇形遮罩。 */
const gadgetCd = a => GADGETS[a.gd].cooldown * Math.pow(.75, (a.pk && a.pk.cooling) || 0);
const dashCdOf = a => 6 * Math.pow(.75, (a.pk && a.pk.dash) || 0);

export function bindAbilityButtons() {
  $("dashButton").addEventListener("click", () => { S.actions |= 1; });
  $("gadgetButton").addEventListener("click", () => { S.actions |= 2; });
  $("superButton").addEventListener("click", () => { S.actions |= 4; });
  const toggle = () => {
    S.assist = !S.assist;
    $("assistToggle").setAttribute("aria-pressed", String(S.assist));
    $("assistGame").classList.toggle("active", S.assist);
    $("assistGame").setAttribute("aria-pressed", String(S.assist));
  };
  $("assistToggle").addEventListener("click", toggle);
  $("assistGame").addEventListener("click", toggle);
}

export function updateHud(V) {
  const me = V.player;
  if (!me) return;
  if (V.time - lastHud < .09 && V.time > lastHud) return;
  lastHud = V.time;
  setStats(V, me);
  drawMini(V);
  updateContracts(V, me);
  updateFeed();
  updateAnnounce();
}

function setStats(V, me) {
  $("aliveValue").textContent = V.actors.filter(a => a.al).length;
  $("gameTime").textContent = clock(V.time);
  $("killCount").textContent = "淘汰 " + me.ki;
  $("cubeValue").textContent = me.cu;

  const hp = me.hp / me.mh;
  $("healthFill").style.width = hp * 100 + "%";
  $("healthFill").style.background = hp < .28 ? "linear-gradient(90deg,#e56e86,#ffa78c)" : "";
  $("healthText").textContent = `${Math.ceil(me.hp)} / ${Math.round(me.mh)}`;
  document.querySelectorAll(".ammo-track i").forEach((el, i) => { el.style.width = clamp(me.am - i, 0, 1) * 100 + "%"; });

  const pct = clamp(me.su, 0, 100), ready = pct >= 99.99;
  $("superValue").textContent = ready ? "就绪" : Math.floor(pct) + "%";
  $("superButton").classList.toggle("ready", ready);
  $("superButton").style.background = ready ? "" : `conic-gradient(#c6935c ${pct * 3.6}deg,#273446 ${pct * 3.6}deg)`;
  $("superButton").setAttribute("aria-label", ready
    ? heroOf(me.h).superName + "已就绪"
    : `超级技能充能 ${Math.floor(pct)}%`);

  $("dashValue").textContent = me.dc > 0 ? me.dc.toFixed(1) + "s" : "闪避";
  $("dashButton").querySelector(".cooldown-fill").style.clipPath =
    `inset(${clamp(100 - me.dc / dashCdOf(me) * 100, 0, 100)}% 0 0 0)`;
  $("gadgetValue").textContent = me.gc > 0 ? Math.ceil(me.gc) + "s" : GADGETS[me.gd].name;
  $("gadgetButton").querySelector(".cooldown-fill").style.clipPath =
    `inset(${clamp(100 - me.gc / gadgetCd(me) * 100, 0, 100)}% 0 0 0)`;
  $("gadgetIcon").setAttribute("href", "#i-" + GADGETS[me.gd].icon);

  $("matchLevel").textContent = "LV." + me.lv;
  $("xpFill").style.width = (me.lv >= 6 ? 100 : me.xp / me.nx * 100) + "%";
  $("playerName").textContent = me.n;

  if (V.mode === "control") {
    $("blueScore").textContent = V.score[0];
    $("redScore").textContent = V.score[1];
    $("blueProgress").style.width = Math.min(50, V.score[0] / 2) + "%";
    $("redProgress").style.width = Math.min(50, V.score[1] / 2) + "%";
    $("matchTimer").textContent = V.time >= 180 ? "加时" : clock(Math.max(0, 180 - V.time));
    $("stormLabel").textContent = zoneLabel(V, me) + " / " + Math.ceil(40 - V.time % 40) + "s 迁移";
    $("stormStatus").classList.toggle("danger", V.zone.ow >= 0 && V.zone.ow !== me.tm);
  } else {
    const outside = Math.hypot(me.x - V.ring.x, me.y - V.ring.y) > V.ring.r;
    $("stormStatus").classList.toggle("danger", outside);
    $("stormLabel").textContent = outside
      ? "风暴中！回到安全区"
      : V.time < 20 ? "风暴来袭 " + clock(Math.max(0, 20 - V.time)) : "安全区持续缩小";
  }

  const dead = !me.al && V.phase === "live";
  $("respawnOverlay").classList.toggle("hidden", !dead);
  if (dead) $("respawnCounter").textContent = Math.max(1, Math.ceil(me.rs));
  $("hitMarker").classList.toggle("show", performance.now() < S.hitUntil);

  const tip = $("gameTip");
  const drop = V.supplies.find(s => s.state === "ready");
  if (me.ov > V.time) {
    tip.innerHTML = `<span>超频启动</span>火力与装填加速 / ${Math.ceil(me.ov - V.time)}s`;
    tip.style.opacity = "1";
  } else if (drop && Math.hypot(drop.x - me.x, drop.y - me.y) < 450) {
    tip.innerHTML = "<span>空投已落地</span>拾取：恢复生命、弹药、超能 · 火力加速 7 秒";
    tip.style.opacity = "1";
  } else tip.style.opacity = V.time < 10 ? "1" : "0";
}

function zoneLabel(V, me) {
  if (V.zone.ct) return "双方争夺 · 暂停计分";
  if (V.zone.ow < 0) return "进入热点，开始占领";
  return V.zone.ow === me.tm ? "我方占领 · 持续得分" : "敌方占领 · 立即夺回";
}

/** 开局的静态部分：模式、地图名、头像、装置说明。每局只做一次。 */
export function primeMatch({ mode, mapSeed, hero, name }) {
  const control = mode === "control";
  $("teamScore").classList.toggle("hidden", !control);
  $("survivalScore").classList.toggle("hidden", control);
  $("mapHeading").innerHTML = control
    ? "霓虹中枢<small>热点争夺 / 3V3 · 种子 " + mapSeed + "</small>"
    : "尘星遗迹<small>荒野生存 / 混战 · 种子 " + mapSeed + "</small>";
  $("gameTip").innerHTML = control
    ? "<span>战术提示</span>跟随菱形指引占点 · 双方同时在圈内不计分"
    : "<span>战术提示</span>先击碎能量箱升级 · 注意 20 秒后的风暴";
  $("superButton").title = heroOf(hero).superName + "（Q / 右键）";
  drawPortrait($("playerPortrait"), hero, true);
  $("killFeed").replaceChildren();
  $("perkStrip").replaceChildren();
  $("playerName").textContent = name;
}

export function updateContracts(V, me) {
  const rows = contractsOf({ mode: V.mode }, {
    kills: me.ki, collected: me.co || 0, captureTime: me.cp || 0, damage: me.dd || 0,
  });
  $("contractRows").innerHTML = rows.map(c => {
    const done = c.value >= c.target;
    return `<div class="contract-row ${done ? "complete" : ""}"><span>${done ? "✓ " : ""}${c.name}</span>` +
      `<b>${Math.min(c.value, c.target)} / ${c.target}${c.suffix || ""}</b></div>`;
  }).join("");
}

export function updatePerks(perks, perksById) {
  const el = $("perkStrip");
  const parts = Object.entries(perks || {}).map(([id, n]) => {
    const p = perksById(id);
    return p ? `<span class="perk-chip">${p.name}${n > 1 ? " ×" + n : ""}</span>` : "";
  }).filter(Boolean);
  el.innerHTML = parts.join("");
}

export function updateFeed() {
  const feed = $("killFeed");
  const now = performance.now();
  feed.replaceChildren();
  for (const line of FX.feed.filter(f => now - f.at < 7000)) {
    const el = document.createElement("div");
    el.className = "feed-line";
    const who = document.createElement(line.mine ? "b" : "span");
    who.textContent = line.who;
    const mid = document.createElement("span");
    mid.className = "feed-mid";
    mid.textContent = " ✕ ";
    const target = document.createElement("span");
    target.textContent = line.target;
    el.append(who, mid, target);
    feed.append(el);
  }
}

function updateAnnounce() {
  const box = $("announcement");
  const a = FX.announce;
  if (!a) { box.classList.remove("show"); return; }
  if (box.dataset.at === String(a.at)) return;
  box.dataset.at = String(a.at);
  $("announcementTitle").textContent = a.title;
  $("announcementSub").textContent = a.sub;
  box.classList.remove("show");
  void box.offsetWidth;
  box.classList.add("show");
}

/** 小地图：只画快照里有的实体，所以它天然就是"我能看见的战场"。 */
function drawMini(V) {
  const c = mini(), s = 160 / WORLD;
  c.clearRect(0, 0, 160, 160);
  c.fillStyle = "#132737"; c.fillRect(0, 0, 160, 160);
  c.save(); c.scale(s, s);
  c.fillStyle = "#38566b";
  for (const w of S.map.walls) c.fillRect(w.x, w.y, TILE, TILE);
  c.fillStyle = "#356c66";
  for (const b of S.map.bushes) c.fillRect(b.x, b.y, TILE, TILE);
  if (V.mode === "control") {
    const color = V.zone.ct ? "#fed18e" : V.zone.ow === 1 ? "#ff9bb3" : "#72fce1";
    ellipse(c, V.zone.x, V.zone.y, V.zone.r, V.zone.r, color + "25", color, 14);
    ellipse(c, V.zone.x, V.zone.y, 25, 25, color);
    if (V.time % 40 > 32) {
      const next = ZONE_POINTS[(Math.floor(V.time / 40) + 1) % ZONE_POINTS.length];
      c.setLineDash([25, 22]);
      ellipse(c, next[0] * TILE, next[1] * TILE, V.zone.r, V.zone.r, null, "#c8e5f566", 10);
      c.setLineDash([]);
    }
  } else if (V.ring.r < 3000) {
    c.save();
    c.beginPath(); c.rect(0, 0, WORLD, WORLD);
    c.arc(V.ring.x, V.ring.y, V.ring.r, 0, Math.PI * 2, true);
    c.clip("evenodd");
    c.fillStyle = "#743c7a88"; c.fillRect(0, 0, WORLD, WORLD);
    c.restore();
  }
  for (const sp of V.supplies) poly(c, [[sp.x, sp.y - 36], [sp.x + 31, sp.y], [sp.x, sp.y + 36], [sp.x - 31, sp.y]], "#d1b5ff");
  for (const a of V.actors) {
    if (!a.al) continue;
    const mine = a.i === S.actorId;
    if (mine) ellipse(c, a.x, a.y, 35, 35, "#e9fff7", "#45b6a1", 12);
    else if (V.mode === "control" && V.player && a.tm === V.player.tm) ellipse(c, a.x, a.y, 26, 26, "#64e4d4", "#24645e", 8);
    else ellipse(c, a.x, a.y, 24, 24, "#ff8da8", "#683e59", 8);
  }
  c.strokeStyle = "#c1e7f43a"; c.lineWidth = 9;
  c.strokeRect(S.cam.x - S.view.w / (2 * S.view.zoom), S.cam.y - S.view.h / (2 * S.view.zoom),
    S.view.w / S.view.zoom, S.view.h / S.view.zoom);
  c.restore();
}

export const modeNameOf = id => (MODES[id] || MODES.control).name;
