/**
 * 对局会话：一条 WebSocket 上的全部收发与分发。
 *
 * 这里刻意不写任何规则。它只做三件事：
 *   1. 开/关连接，并把一条消息分发到各个模块（房间视图 → roomui，地图 → render，
 *      快照 → view/predict，事件 → fx，结算 → results）；
 *   2. 在服务端说"开局/结算"时切换屏幕；
 *   3. 给上层一个 `send()`，别的模块不碰 socket。
 *
 * 一条最容易被忽略的约定：**界面跟着服务端走**。收到 `room` 说还在 staging，
 * 哪怕我这边已经切到竞技场了，也要乖乖切回候场——反过来就会两边不一致。
 */

import { decodeMap } from "/sim/wire.mjs";
import { perkById } from "/sim/data.mjs";
import { S } from "./state.mjs";
import { openSocket, startPing } from "./net.mjs";
import { connect, refresh } from "./rooms.mjs";
import { pushSnapshot } from "./view.mjs";
import { initPredict, reconcile, applyBoxUpdates } from "./predict.mjs";
import { buildGround } from "./render.mjs";
import { seedFx, consumeEvents } from "./fx.mjs";
import { play } from "./audio.mjs";
import { renderRoom } from "./roomui.mjs";
import { showResults, hideResults } from "./results.mjs";
import { primeMatch, updatePerks } from "./hud.mjs";
import { selectedHero, prefsOf } from "./showcase.mjs";
import { setScreen, resetMatchState } from "./screens.mjs";
import { showUpgrade, hideUpgrade } from "./upgrade.mjs";

const $ = id => document.getElementById(id);

let link = null;
let stopPing = null;
let primed = false;

/** 别的模块要发消息时统一走这里，socket 的生命周期只由本模块管。 */
export const send = payload => link?.send(payload);
export const linkState = () => link;

export async function joinRoom(roomId) {
  leaveRoom(false);
  if (!S.token) await connect();
  resetMatchState();
  primed = false;
  link = openSocket(roomId, { onMessage: onServerMessage, onClose: onSocketClose, onError: () => {} });
  stopPing = startPing(link);
  $("roomTitle").textContent = "正在进入房间…";
  setScreen("staging");
}

export function leaveRoom(goRooms = true) {
  if (stopPing) { stopPing(); stopPing = null; }
  if (link) { link.close(); link = null; }
  resetMatchState();
  primed = false;
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
      send({ t: "hero", i: selectedHero() });
      send({ t: "gadget", id: prefsOf().gadget });
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

const mineIn = snapshot => snapshot.a.find(a => a.ow && a.ow === S.meId) || null;

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

/** 结算页的主按钮对房主和普通玩家含义不同：一个能重开，一个只能回候场等。 */
function primeResultButtons() {
  const host = !!(S.room && S.room.you && S.room.you.host);
  $("playAgainButton").firstChild.textContent = host ? "再来一局 " : "回到候场 ";
  $("playAgainButton").disabled = false;
}
