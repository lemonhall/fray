/**
 * 候场页：房间条 + 参战名册 + 房主控制。
 *
 * 这一层是"权限"在界面上的投影：同一份房间视图（`{t:"room"}`）到了不同的人手里
 * 长得不一样——房主看到的机器人加减按钮是可点的，别人看到的是灰的。**但真正的
 * 拒绝发生在服务端**（`isHost`），这里只是别让人白点。界面永远不是安全边界。
 */

import { HEROS, MODES, DIFFICULTIES } from "/sim/data.mjs";
import { drawPortrait } from "./showcase.mjs";
import { S } from "./state.mjs";

const $ = id => document.getElementById(id);

let hooks = {};
let view = null;
let selectedMode = "control";
let selectedDifficulty = 1;

export function bindRoom(next) {
  hooks = next;
  $("botStepper").querySelectorAll("[data-bot]").forEach(button => {
    button.addEventListener("click", () => {
      if (!isHost()) return;
      const step = Number(button.dataset.bot);
      hooks.onBots?.(Math.max(0, Math.min(maxBots(), (view?.bots || 0) + step)));
    });
  });
  document.querySelectorAll("[data-mode]").forEach(card => {
    card.addEventListener("click", () => {
      if (!isHost()) return;
      hooks.onConfig?.({ mode: card.dataset.mode });
    });
  });
  document.querySelectorAll("[data-difficulty]").forEach(button => {
    button.addEventListener("click", () => {
      if (!isHost()) return;
      hooks.onConfig?.({ difficulty: Number(button.dataset.difficulty) });
    });
  });
  $("startButton").addEventListener("click", () => { if (isHost()) hooks.onStart?.(); });
  $("leaveRoomButton").addEventListener("click", () => hooks.onLeave?.());
  setHostUi(false);
}

const isHost = () => !!(view && view.you && view.you.host);
const maxBots = () => (view ? Math.min(view.maxBots, (MODES[view.mode] || MODES.control).bots) : 9);

function setHostUi(host) {
  const panel = $("rosterPanel");
  panel.classList.toggle("guest", !host);
  $("botStepper").querySelectorAll("button").forEach(b => { b.disabled = !host; });
  document.querySelectorAll("[data-mode],[data-difficulty]").forEach(el => {
    el.disabled = !host;
    el.title = host ? "" : "只有房主能改房间配置";
  });
  $("startButton").disabled = !host;
}

/** 服务端每次广播房间状态都会走到这里，所以界面永远只是它的投影。 */
export function renderRoom(next) {
  view = next;
  const phase = view.ph;
  const mode = MODES[view.mode] || MODES.control;
  selectedMode = view.mode;
  selectedDifficulty = view.diff;
  $("roomPhase").textContent = phase === "live" ? "对局中" : phase === "over" ? "已结算" : "准备中";
  $("roomPhase").className = "phase-badge " + (phase === "live" ? "live" : phase === "over" ? "over" : "");
  $("roomTitle").textContent = view.name;
  $("roomCodeLabel").textContent = "#" + view.id;
  $("roomMeta").textContent =
    `${mode.name} · ${mode.sub} · ${view.members.length} 人 + ${view.bots} 机器人 · 难度 ${DIFFICULTIES[view.diff].name}`;
  $("rosterCount").textContent = `${view.members.length} / ${view.capacity}`;
  renderRoster(view);
  $("botCount").textContent = view.bots;
  $("startModeLabel").textContent = `${mode.name} · ${mode.sub}`;
  syncModeCards(mode.id);
  syncDifficulty(view.diff);
  setHostUi(isHost());
  $("rosterNote").textContent = isHost()
    ? (view.members.length + view.bots < 2 ? "至少要有两个参战者才能开打（加个机器人就行）" : "你是房主，随时可以开打")
    : "等待房主开始…";
  $("rosterNote").classList.toggle("warn", view.members.length + view.bots < 2);
  $("teamNote").textContent = view.mode === "control"
    ? `${view.members.length} 名真人 + ${view.bots} 个机器人 · 前两名真人分属两队`
    : `${view.members.length} 名真人 + ${view.bots} 个机器人 · 各自为战`;
  $("startButton").querySelector("span").firstChild.textContent = isHost() ? "出发，开打" : "等待房主开始";
}

function renderRoster(current) {
  const box = $("rosterRows");
  box.replaceChildren();
  for (const member of current.members) {
    const chip = document.createElement("div");
    chip.className = "roster-chip" + (member.me ? " me" : "");
    const canvas = document.createElement("canvas");
    canvas.width = 26; canvas.height = 26;
    const label = document.createElement("div");
    const strong = document.createElement("span");
    strong.textContent = member.n;
    const small = document.createElement("small");
    small.textContent = HEROS[member.hero].name + (member.id === current.host ? " · 房主" : "");
    label.append(strong, small);
    chip.append(canvas, label);
    if (member.id === current.host) {
      const crown = document.createElement("span");
      crown.className = "host-crown";
      crown.textContent = "★";
      chip.append(crown);
    }
    box.append(chip);
    drawPortrait(canvas, member.hero);
  }
  for (let i = 0; i < current.bots; i++) {
    const chip = document.createElement("div");
    chip.className = "roster-chip bot";
    chip.innerHTML = `<span class="host-crown">🤖</span><div><span>机器人</span><small>BOT ${i + 1}</small></div>`;
    box.append(chip);
  }
}

function syncModeCards(mode) {
  document.querySelectorAll("[data-mode]").forEach(card => {
    const on = card.dataset.mode === mode;
    card.classList.toggle("selected", on);
    card.setAttribute("aria-pressed", String(on));
  });
}

function syncDifficulty(difficulty) {
  document.querySelectorAll("[data-difficulty]").forEach(button => {
    const on = Number(button.dataset.difficulty) === difficulty;
    button.classList.toggle("selected", on);
    button.setAttribute("aria-pressed", String(on));
  });
}

export const currentRoom = () => view;
export const roomIsHost = isHost;
export const chosenConfig = () => ({ mode: selectedMode, difficulty: selectedDifficulty });

/** 候场页可见时的兜底：服务端还没推过房间视图时，至少别让界面是空的。 */
export function ensureRoomVisible() {
  if (view) renderRoom(view);
}
