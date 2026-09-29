/**
 * 编排层：主循环、输入上行、启动接线。
 *
 * 这里刻意不写任何规则。它只做三件事：
 *   1. 以固定 60Hz 跑**只预测我自己**的位移，并以 25Hz 把输入意图发出去；
 *   2. 每帧把最新快照插值成画面，再把 HUD 同步到 DOM；
 *   3. 把界面上的按钮接到"发一条消息"上。
 *
 * 房间与对局的协议处理在 `session.mjs`，屏幕切换在 `screens.mjs`，
 * 升级弹窗在 `upgrade.mjs`——这个文件只负责"把它们串起来，然后一直转下去"。
 */

import { DT, clamp } from "/sim/constants.mjs";
import { heroOf } from "/sim/data.mjs";
import { S } from "./state.mjs";
import { attachInput, bindStick, clearInputs, moveBits, moveVector, aimAngle, aimRange } from "./input.mjs";
import { buildView } from "./view.mjs";
import { stepPredict } from "./predict.mjs";
import { initCmds, frameDir, noteTick, flushCmd } from "./cmd.mjs";
import { renderGame } from "./render.mjs";
import { stepFx } from "./fx.mjs";
import { initAudio, toggleSound } from "./audio.mjs";
import { initRooms, connect } from "./rooms.mjs";
import { bindRoom, roomIsHost } from "./roomui.mjs";
import { updateHud, bindAbilityButtons } from "./hud.mjs";
import { hideResults, bindResults } from "./results.mjs";
import { initLoadout, resizeShowcase, renderShowcase, selectedHero, prefsOf } from "./showcase.mjs";
import { joinRoom, leaveRoom, send } from "./session.mjs";
import { setScreen, togglePause } from "./screens.mjs";
import { bindUpgrade, choosePerk } from "./upgrade.mjs";
import { joinFromLink, copyInvite } from "./invite.mjs";

const $ = id => document.getElementById(id);
/** 单帧最多补几格（60Hz 下的 400ms）：浏览器卡一下之后要把时间补回来，不能靠丢时间混过去。 */
const MAX_TICKS_PER_FRAME = 24;
const ctx = () => $("game").getContext("2d");

const state = { last: 0, acc: 0, view: null };

// ---------------------------------------------------------------- 主循环

function frame(now) {
  const delta = Math.min((now - state.last) / 1000, .25) || 0;
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
    let angle = aimAngle(S, me);
    let fire = S.mouse.down || S.touch.aim.active ? 1 : 0;
    // 辅助开火：只挑快照里出现过的敌人——也就是说，只有看得见才帮得忙。
    if (S.assist) {
      const target = assistTarget();
      if (target) { angle = Math.atan2(target.y - me.y, target.x - me.x); fire = 1; }
    }
    const flags = { k: moveBits(S), f: fire, r: aimRange(S, me) };
    // 一条命令 = "这一帧按着这个方向、已经走了几格"。方向变了 frameDir 会顺手把
    // 上一条收尾发走，所以服务端收到的永远方向单一、格数明确——重放的精度全靠它。
    const cmd = frameDir(now, dir.x, dir.y, angle, flags);
    state.acc += delta;
    let guard = 0;
    while (state.acc >= DT && guard++ < MAX_TICKS_PER_FRAME) {
      // 死了就不预测位移：服务端那一侧也停着，预测了等于自己给自己造分歧。
      if (me.alive) { stepPredict(S, DT, cmd.mx, cmd.my, cmd.a); noteTick(cmd); }
      state.acc -= DT;
    }
    if (state.acc > DT * 2) state.acc = DT * 2;
    const ease = Math.min(1, delta * 9);
    S.cam.x += (me.x - S.cam.x) * ease;
    S.cam.y += (me.y - S.cam.y) * ease;
    // 死了也要发：这条 n=0 的命令不推人，但推世界——不然房间里只剩 ping 的时候，
    // 全灭之后世界会一格一格地慢下来。
    if (S.screen === "play") flushCmd(now, flags);
  }
  stepFx(delta);
  renderGame(ctx(), view, S.ground);
  updateHud(view);
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

function bindShell() {
  $("pauseButton").addEventListener("click", () => togglePause(true));
  $("resumeButton").addEventListener("click", () => { togglePause(false); $("game").focus({ preventScroll: true }); });
  $("exitButton").addEventListener("click", () => { togglePause(false); leaveRoom(true); });
  $("restartButton").classList.add("hidden");   // 联机没有"自己重开"，只有房主能重开
  const openHelp = () => {
    $("modalBackdrop").classList.remove("hidden");
    $("pauseModal").classList.add("hidden");
    $("helpModal").classList.remove("hidden");
  };
  $("helpLobby").addEventListener("click", openHelp);
  $("helpHeader").addEventListener("click", openHelp);
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
  bindUpgrade(send);
  // 命令时间线的出口交给编排层：cmd.mjs 只管攒命令，不碰 socket。
  initCmds(send);
  initLoadout({ onHero: i => send({ t: "hero", i }), onGadget: id => send({ t: "gadget", id }) });
  bindRoom({
    onBots: n => send({ t: "bots", n }),
    onConfig: patch => send({ t: "config", ...patch }),
    onStart: () => send({ t: "start" }),
    onLeave: () => leaveRoom(true),
    // 举手 / 选边 / 踢人：三个都是"我的意图"，服务端才是拍板的那一方。
    onReady: v => send({ t: "ready", v }),
    onTeam: tm => send({ t: "team", tm: tm === null ? "auto" : tm }),
    onKick: id => send({ t: "kick", id }),
    // 分享：一条链接把朋友拉进这间房（房间码大小写都认）。
    onShare: id => void copyInvite(id),
  });
  bindResults({
    onReset: () => { if (roomIsHost()) send({ t: "reset" }); else { hideResults(); setScreen("staging"); } },
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
  // `?room=CODE`：拿到邀请链接的人直接进场，不必先在列表里找房间。
  await joinFromLink();
  requestAnimationFrame(frame);
  window.FRAY = { version: "1.0", S, snapshot: () => ({ screen: S.screen, room: S.room, me: S.mine, rtt: S.rtt }) };
}

void boot();
