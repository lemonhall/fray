/**
 * 屏幕切换与"开局前的清理"。
 *
 * `S.screen` 是**界面状态**，不是对局状态：真正的阶段（staging / live / over）
 * 永远在服务端的房间视图里。界面可以比服务端慢半拍，但绝不能反过来——
 * 那就是"我这边显示赢了、别人那边还在打"的来源。
 *
 * 这一层刻意不 import 任何网络模块：它只认识 DOM 与 `S`，所以谁都能安全地用，
 * 也不会有模块循环依赖。
 */

import { S, FX } from "./state.mjs";
import { startAutoRefresh, stopAutoRefresh } from "./rooms.mjs";
import { resizeShowcase } from "./showcase.mjs";
import { clearInputs } from "./input.mjs";
import { hideUpgrade } from "./upgrade.mjs";

const $ = id => document.getElementById(id);

export function setScreen(screen) {
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

/** 每一局开局前都要把上一局的残留清干净，否则新地图上会飘着旧局的粒子。 */
export function resetMatchState() {
  S.snaps = []; S.map = null; S.ground = null; S.predictW = null; S.predictMe = null;
  // 插值时间线必须跟着清：留着上一局的锚点，新一局的第一个快照会被当成"落后半秒"
  // 而触发一次瞬移，开打瞬间画面就会跳一下。
  S.wall = 0; S.lastTm = 0; S.headTm = 0; S.headAt = 0;
  S.me = null; S.actorId = 0; S.meTeam = 0; S.results = null; S.shake = 0; S.hitUntil = 0;
  FX.particles = []; FX.floaters = []; FX.rings = []; FX.beams = []; FX.feed = []; FX.announce = null;
  hideUpgrade();
  $("upgradeOverlay").classList.add("hidden");
  $("respawnOverlay").classList.add("hidden");
}

/** 暂停/帮助共用一个遮罩：它们永远不该同时出现。 */
export function togglePause(show) {
  $("modalBackdrop").classList.toggle("hidden", !show);
  $("pauseModal").classList.toggle("hidden", !show);
  $("helpModal").classList.add("hidden");
  if (!show) clearInputs(S);
}
