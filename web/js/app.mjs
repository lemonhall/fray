/**
 * 编排层：屏幕切换、输入上行、对局表现循环。
 *
 * 这里刻意不写任何规则。它只做三件事：
 *   1. 把一条 WebSocket 上的消息分发到各个模块（房间视图 → roomui，地图 → render，
 *      快照 → view/predict，事件 → fx，结算 → results）；
 *   2. 以固定 60Hz 跑**只预测我自己**的位移，并以 25Hz 把输入意图上行；
 *   3. 每帧把最新快照插值成画面，再把 HUD 同步到 DOM。
 *
 * 一条最容易被忽略但很重要的约定：`S.screen` 是**界面状态**，不是对局状态。
 * 对局状态永远在服务端（房间视图里的 `ph`）。界面可以比服务端慢半拍，
 * 但绝不能反过来——那就是"我这边显示赢了、别人那边还在打"的来源。
 */

import { DT, clamp } from "/sim/constants.mjs";
import { decodeMap } from "/sim/wire.mjs";
import { perkById, heroOf } from "/sim/data.mjs";
import { S, FX } from "./state.mjs";
import { attachInput, bindStick, clearInputs, frameOf, moveVector, aimAngle } from "./input.mjs";
import { pushSnapshot, buildView } from "./view.mjs";
import { initPredict, stepPredict, reconcile, applyBoxUpdates } from "./predict.mjs";
import { buildGround, renderGame } from "./render.mjs";
import { seedFx, consumeEvents, stepFx } from "./fx.mjs";
import { initAudio, toggleSound, play } from "./audio.mjs";
import { openSocket, startPing } from "./net.mjs";
import { initRooms, connect, startAutoRefresh, stopAutoRefresh, refresh } from "./rooms.mjs";
import { bindRoom, renderRoom, roomIsHost } from "./roomui.mjs";
import { updateHud, primeMatch, bindAbilityButtons, updatePerks } from "./hud.mjs";
import { showResults, hideResults, bindResults } from "./results.mjs";
import { initLoadout, resizeShowcase, renderShowcase, selectedHero, prefsOf } from "./showcase.mjs";

const $ = id => document.getElementById(id);
const SEND_MS = 40;              // 25Hz 上行：比广播窗口（50ms）密一点，快照才不会跳格子
const ctx = () => $("game").getContext("2d");

let link = null;
let stopPing = null;
const state = { last: 0, acc: 0, lastSent: 0, view: null };

// ---------------------------------------------------------------- 屏幕切换

function setScreen(screen) {
  S.screen = screen;
  $("rooms").classList.toggle("hidden", screen !== "rooms");
  $("lobby").classList.toggle("hidden", screen !== "staging");
  $("arena").classList.toggle("hidden", screen !== "play");
  $("results").classList.toggle("hidden", screen !== "over");
  document.body.classList.toggle("rooms-open", screen === "rooms");
  stopAutoRefresh();
  if (screen === "rooms") {
    startAutoRefresh();
    document.body.style.overflow = "";
    $("app").style.minHeight = "";
  }
  if (screen === "staging") { document.body.style.overflow = ""; $("app").style.minHeight = ""; resizeShowcase(); }
  if (screen === "play") {
    document.body.style.overflow = "hidden";
    $("app").style.minHeight = "0";
    window.scrollTo(0, 0);
    $("modalBackdrop").classList.add("hidden");
    $("game").focus({ preventScroll: true });
  }
}

function resetMatchState() {
  S.snaps = []; S.map = null; S.ground = null; S.predictW = null; S.predictMe = null;
  S.me = null; S.actorId = 0; S.meTeam = 0; S.results = null; S.shake = 0; S.hitUntil = 0;
  FX.particles = []; FX.floaters = []; FX.rings = []; FX.beams = []; FX.feed = []; FX.announce = null;
  hideUpgrade();
  $("upgradeOverlay").classList.add("hidden");
  $("respawnOverlay").classList.add("hidden");
}

// ---------------------------------------------------------------- 连接

async function joinRoom(roomId) {
  leaveRoom(false);
  if (!S.token) await connect();
  resetMatchState();
  link = openSocket(roomId, { onMessage: onServerMessage, onClose: onSocketClose, onError: () => {} });
  stopPing = startPing(link);
  $("roomTitle").textContent = "正在进入房间…";
  setScreen("staging");
}

function leaveRoom(goRooms = true) {
  if (stopPing) { stopPing(); stopPing = null; }
  if (link) { link.close(); link = null; }
  resetMatchState();
  if (goRooms) { void refresh(); setScreen("rooms"); }
}

function onSocketClose() {
  if (S.screen === "rooms") return;
  $("screenReaderStatus").textContent = "与房间的连接已断开。";
  leaveRoom(true);
}

function onServerMessage(msg) {
  switch (msg.t) {
    case "hello":
      S.room = msg.room;
      renderRoom(msg.room);
      link?.send({ t: "hero", i: selectedHero() });
      link?.send({ t: "gadget", id: prefsOf().gadget });
      return;
    case "room":
      S.room = msg;
      renderRoom(msg);
      if (msg.ph === "staging" && S.screen !== "staging") { hideResults(); setScreen("staging"); }
      return;
    case "begin":
      S.room = msg.room;
      renderRoom(msg.room);
      resetMatchState();
      setScreen("play");
      play("start");
      return;
    case "map":
      S.map = decodeMap(msg);
      S.ground = buildGround(S.map);
      seedFx(msg.seed);
      primed = false;
      // 中途加入的人不会收到 `begin`（那是对局开始那一刻的广播），所以他必须靠
      // "房间已经是 live" 来判断该进场。少这一条，人就会卡在候场页看别人打。
      if (S.room?.ph === "live" && S.screen !== "play") setScreen("play");
      return;
    case "s": return onSnapshot(msg);
    case "over":
      S.results = msg.results;
      showResults(msg.results);
      primeResultButtons();
      setScreen("over");
      play(winFrom(msg.results) ? "win" : "lose");
      return;
    case "pong": S.rtt = Math.round(performance.now() - S.lastPingAt); return;
    case "error":
      $("screenReaderStatus").textContent = `服务端拒绝：${msg.error}`;
      if (msg.error === "room_full") leaveRoom(true);
      return;
    default: return;
  }
}

let primed = false;

function mineIn(snapshot) {
  return snapshot.a.find(a => a.ow && a.ow === S.meId) || null;
}

function onSnapshot(snapshot) {
  pushSnapshot(S, snapshot);
  consumeEvents(snapshot.ev);
  const mine = mineIn(snapshot);
  if (!mine) return;
  if (snapshot.bx && snapshot.bx.length) applyBoxUpdates(S.map, snapshot.bx);
  if (S.map && !S.predictW) initPredict(S, S.map, mine);
  reconcile(S, mine);
  S.meTeam = mine.tm;
  S.mine = mine;
  if (!primed && S.map) {
    primed = true;
    primeMatch({ mode: S.map.mode, mapSeed: S.map.seed, hero: mine.h, name: mine.n });
  }
  if (mine.of && mine.of.length) showUpgrade(mine.of, mine.lv);
  else hideUpgrade();
  updatePerks(mine.pk, perkById);
}

const winFrom = results => {
  const me = (results.players || []).find(p => p.ownerId === S.meId);
  if (!me) return false;
  return results.kind === "control" ? results.winnerTeam === me.team : me.rank === 1;
};

function primeResultButtons() {
  const host = roomIsHost();
  $("playAgainButton").firstChild.textContent = host ? "再来一局 " : "回到候场 ";
  $("playAgainButton").disabled = false;
}

// ---------------------------------------------------------------- 三选一

function showUpgrade(offers, level) {
  const box = $("upgradeCards");
  if (box.dataset.for === offers.join(",")) { $("upgradeOverlay").classList.remove("hidden"); return; }
  box.dataset.for = offers.join(",");
  box.replaceChildren();
  $("upgradeTitle").textContent = `LV.${level} · 战场进化`;
  offers.forEach((id, i) => {
    const perk = perkById(id);
    const button = document.createElement("button");
    button.className = "upgrade-card";
    button.innerHTML = `<kbd>${i + 1}</kbd><span class="upgrade-icon">${perk.icon}</span>` +
      `<small>${perk.tag}</small><strong>${perk.name}</strong><p>${perk.description}</p>` +
      `<em>${(S.mine?.pk?.[id] || 0) ? `强化至 ${S.mine.pk[id] + 1} 层` : "全新强化"}</em>`;
    button.dataset.perk = id;
    button.addEventListener("click", () => choosePerk(id));
    box.append(button);
  });
  $("upgradeOverlay").classList.remove("hidden");
  $("upgradeOverlay").querySelector(".upgrade-card")?.focus({ preventScroll: true });
}

function hideUpgrade() {
  $("upgradeOverlay").classList.add("hidden");
  $("upgradeCards").dataset.for = "";
}

function choosePerk(id) {
  link?.send({ t: "perk", id });
  hideUpgrade();
  play("click");
}

// ---------------------------------------------------------------- 主循环

function frame(now) {
  const delta = Math.min((now - state.last) / 1000, .1) || 0;
  state.last = now;
  if (S.screen === "rooms" || S.screen === "staging") renderShowcase(now / 1000);
  if (S.screen === "play" || S.screen === "over") tickArena(delta, now);
  requestAnimationFrame(frame);
}

function tickArena(delta, now) {
  const view = buildView(S);
  if (!view || !S.map || !S.ground) return;
  state.view = view;
  const me = S.predictMe;
  if (me) {
    const dir = moveVector(S);
    const angle = aimAngle(S, me);
    state.acc += delta;
    let guard = 0;
    while (state.acc >= DT && guard++ < 8) { stepPredict(S, DT, dir.x, dir.y, angle); state.acc -= DT; }
    if (state.acc >= DT) state.acc = 0;
    const ease = Math.min(1, delta * 9);
    S.cam.x += (me.x - S.cam.x) * ease;
    S.cam.y += (me.y - S.cam.y) * ease;
  }
  stepFx(delta);
  renderGame(ctx(), view, S.ground);
  updateHud(view);
  if (now - state.lastSent >= SEND_MS) sendInput(now);
}

/** 上行一帧输入。角度与开火都只是**意图**，命中与否由服务端说了算。 */
function sendInput(now) {
  if (!link || !S.predictMe || S.screen !== "play") return;
  const me = S.predictMe;
  const frameOut = frameOf(S, me);
  const target = S.assist ? assistTarget() : null;
  if (target) {
    frameOut.a = Math.round(Math.atan2(target.y - me.y, target.x - me.x) * 1000) / 1000;
    frameOut.f = 1;
  }
  link.send(frameOut);
  state.lastSent = now;
}

/** 辅助开火：只挑快照里出现过的敌人——也就是说，只有看得见才帮得忙。 */
function assistTarget() {
  const view = state.view, me = S.mine;
  if (!view || !me || !me.al) return null;
  const range = heroOf(me.h).range + 30;
  let best = null, bestDistance = range;
  for (const actor of view.actors) {
    if (actor.i === me.i || !actor.al) continue;
    if (view.mode === "control" && actor.tm === me.tm) continue;
    const d = Math.hypot(actor.x - me.x, actor.y - me.y);
    if (d < bestDistance) { best = actor; bestDistance = d; }
  }
  return best;
}

function resize() {
  S.dpr = Math.min(window.devicePixelRatio || 1, 2);
  S.view.w = innerWidth; S.view.h = innerHeight;
  S.view.zoom = clamp(Math.min(innerWidth / 1180, innerHeight / 760), .60, 1.25);
  const canvas = $("game");
  canvas.width = Math.round(innerWidth * S.dpr);
  canvas.height = Math.round(innerHeight * S.dpr);
  resizeShowcase();
  const view = buildView(S);
  if (view && S.map && S.ground) renderGame(ctx(), view, S.ground);
}

// ---------------------------------------------------------------- 接线

function togglePause(show) {
  $("modalBackdrop").classList.toggle("hidden", !show);
  $("pauseModal").classList.toggle("hidden", !show);
  $("helpModal").classList.add("hidden");
}

function bindShell() {
  $("pauseButton").addEventListener("click", () => togglePause(true));
  $("resumeButton").addEventListener("click", () => { togglePause(false); clearInputs(S); $("game").focus({ preventScroll: true }); });
  $("exitButton").addEventListener("click", () => { togglePause(false); leaveRoom(true); });
  $("restartButton").classList.add("hidden");   // 联机没有"自己重开"，只有房主能重开
  $("helpLobby").addEventListener("click", () => { $("modalBackdrop").classList.remove("hidden"); $("pauseModal").classList.add("hidden"); $("helpModal").classList.remove("hidden"); });
  $("helpHeader").addEventListener("click", () => { $("modalBackdrop").classList.remove("hidden"); $("pauseModal").classList.add("hidden"); $("helpModal").classList.remove("hidden"); });
  $("closeHelp").addEventListener("click", () => togglePause(false));
  document.querySelectorAll(".sound-toggle").forEach(button => button.addEventListener("click", () => {
    const on = toggleSound();
    button.querySelector("use").setAttribute("href", on ? "#i-sound" : "#i-mute");
  }));
  document.querySelector(".fullscreen-button").addEventListener("click", () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
    else document.exitFullscreen?.();
  });
  document.querySelector(".brand")?.addEventListener("click", event => event.preventDefault());
  window.addEventListener("resize", resize);
  window.addEventListener("blur", () => clearInputs(S));
  document.addEventListener("visibilitychange", () => { if (document.hidden) clearInputs(S); });
}

function bindKeys() {
  document.addEventListener("keydown", event => {
    if (S.screen === "play" && !$("upgradeOverlay").classList.contains("hidden")) {
      if (/^Digit[123]$/u.test(event.code)) {
        event.preventDefault();
        const card = $("upgradeCards").children[+event.code.slice(-1) - 1];
        if (card?.dataset.perk) choosePerk(card.dataset.perk);
      }
      return;
    }
    if (event.code === "Escape" || event.code === "KeyP") {
      event.preventDefault();
      togglePause($("modalBackdrop").classList.contains("hidden") && S.screen === "play");
      return;
    }
    if (S.screen !== "play") return;
    if (event.code === "KeyQ") S.actions |= 4;
    if (event.code === "Space") S.actions |= 1;
    if (event.code === "KeyE") S.actions |= 2;
    if (event.code === "KeyF") $("assistGame").click();
  });
}

async function boot() {
  if (matchMedia("(pointer:coarse)").matches || navigator.maxTouchPoints > 0) {
    document.documentElement.classList.add("touch-device");
  }
  resize();
  bindShell();
  bindKeys();
  bindAbilityButtons();
  initLoadout({ onHero: i => link?.send({ t: "hero", i }), onGadget: id => link?.send({ t: "gadget", id }) });
  bindRoom({
    onBots: n => link?.send({ t: "bots", n }),
    onConfig: patch => link?.send({ t: "config", ...patch }),
    onStart: () => link?.send({ t: "start" }),
    onLeave: () => leaveRoom(true),
  });
  bindResults({
    onReset: () => { if (roomIsHost()) link?.send({ t: "reset" }); else { hideResults(); setScreen("staging"); } },
    onBack: () => { hideResults(); setScreen("staging"); },
  });
  initRooms({ onJoin: roomId => void joinRoom(roomId) });
  attachInput(S, {
    canvas: $("game"),
    onKey: event => { if (event.code === "KeyF") event.preventDefault(); },
  });
  bindStick(S, $("moveStick"), false);
  bindStick(S, $("aimStick"), true);
  if (prefsOf().sound === false) toggleSound();
  initAudio();
  setScreen("rooms");
  await connect();
  requestAnimationFrame(frame);
  window.FRAY = { version: "1.0", S, snapshot: () => ({ screen: S.screen, room: S.room, me: S.mine, rtt: S.rtt }) };
}

void boot();
