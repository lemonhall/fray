/**
 * 候场页：房间条 + 参战名册 + 房主控制。
 *
 * 这一层是"权限"在界面上的投影：同一份房间视图（`{t:"room"}`）到了不同的人手里
 * 长得不一样——房主看到的机器人加减按钮是可点的，别人看到的是灰的。**但真正的
 * 拒绝发生在服务端**（`isHost`），这里只是别让人白点。界面永远不是安全边界。
 */

import { MODES, DIFFICULTIES } from "/sim/data.mjs";
import { renderRoster } from "./roster.mjs";
import { S } from "./state.mjs";

const $ = id => document.getElementById(id);

let hooks = {};
let view = null;
let selectedMode = "control";
let selectedDifficulty = 1;
/**
 * 房里的一次性提示：选边被拒、开局被拒这类"服务端说了不行"的话，必须写在
 * **玩家正看着的那一屏**上。大厅那条 `#roomsNote` 在候场页是隐藏的，写在那儿
 * 等于没说——玩家点一下红队，界面毫无动静，只会以为按钮坏了。
 * 保留几秒，免得被下一次名册广播抹掉。
 */
let noteHoldUntil = 0;

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
  // 分享是每个人都能做的事——"拉人"不该只有房主干得了。
  $("shareRoomButton").addEventListener("click", () => { if (view) hooks.onShare?.(view.id); });
  $("leaveRoomButton").addEventListener("click", () => hooks.onLeave?.());
  // 举手：这是"我准备好了"的唯一入口。房主的按钮是禁用的——他的开打按钮就是表态。
  $("readyButton").addEventListener("click", () => {
    if (isHost()) return;
    hooks.onReady?.(!(view && view.you && view.you.ready));
  });
  $("teamPicker").querySelectorAll("[data-team]").forEach(button => {
    button.addEventListener("click", () => {
      if (!canPickTeam()) return;
      const raw = button.dataset.team;
      hooks.onTeam?.(raw === "auto" ? null : Number(raw));
    });
  });
  $("joinLiveToggle").addEventListener("change", event => {
    if (!isHost()) return;
    hooks.onConfig?.({ joinLive: event.target.checked });
  });
  setHostUi(false);
}

const isHost = () => !!(view && view.you && view.you.host);
const maxBots = () => (view ? Math.min(view.maxBots, (MODES[view.mode] || MODES.control).bots) : 9);
/** 选边只在"分队模式 + 还在候场"的时候有意义。 */
const canPickTeam = () => !!(view && view.teams > 0 && view.ph === "staging");

function setHostUi(host) {
  const panel = $("rosterPanel");
  panel.classList.toggle("guest", !host);
  $("botStepper").querySelectorAll("button").forEach(b => { b.disabled = !host; });
  document.querySelectorAll("[data-mode],[data-difficulty]").forEach(el => {
    el.disabled = !host;
    el.title = host ? "" : "只有房主能改房间配置";
  });
  // "允许中途加入"是房主的开关；选边是每个人自己的事，所以两类控件的禁用条件是分开的。
  $("joinLiveField").classList.toggle("guest", !host);
  $("joinLiveToggle").disabled = !host;
  $("joinLiveField").title = host ? "关掉之后，开打期间不再收新人" : "只有房主能改";
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
    `${mode.name} · ${mode.sub} · ${view.members.length} 人 + ${view.bots} 机器人 · 难度 ${DIFFICULTIES[view.diff].name}` +
    (view.join ? " · 可中途加入" : " · 开打后谢客");
  $("rosterCount").textContent = `${view.members.length} / ${view.capacity}`;
  renderRoster(view, hooks);
  $("botCount").textContent = view.bots;
  $("startModeLabel").textContent = `${mode.name} · ${mode.sub}`;
  syncModeCards(mode.id);
  syncDifficulty(view.diff);
  setHostUi(isHost());
  renderReadyState(view, mode);
  renderTeamPicker(view);
  $("joinLiveToggle").checked = !!view.join;
  renderNotes(view, mode);
}

/** 举手按钮：房主没有这一票，别人点了才算数。 */
function renderReadyState(current, mode) {
  const button = $("readyButton");
  const staging = current.ph === "staging";
  const meReady = !!(current.you && current.you.ready);
  button.classList.toggle("hidden", !staging || isHost());
  button.classList.toggle("on", meReady);
  button.disabled = !staging || isHost();
  button.textContent = meReady ? "已举手 · 点一下取消" : "我准备好了";
  button.title = `${mode.name} · 举手之后房主才能开打`;
  // 开打按钮只在"房主 + 全员举手 + 人数够"的时候才是亮的；服务端还会再拦一次。
  const enough = current.members.length + current.bots >= 2;
  // 超编也要挡住：从荒野生存（上限 10）切回热点争夺（上限 6）时名册不会自动瘦身，
  // 按钮却照亮，点下去只会被服务端回一句 `too_many`——按钮骗人比按钮变灰糟糕多了。
  const ready = isHost() && current.allReady && enough && !overCapacity(current) && current.ph === "staging";
  $("startButton").disabled = !ready;
  $("startButton").classList.toggle("hold", !ready);
  $("startButton").querySelector("span").firstChild.textContent =
    isHost() ? (ready ? "出发，开打" : "等大家举手") : "等待房主开始";
}

const overCapacity = current =>
  current.members.length + current.bots > current.capacity + current.maxBots;

/** 选边：三个按钮（自动 / 蓝 / 红），选中态由服务端回推的 `you.team` 决定。 */
function renderTeamPicker(current) {
  const picker = $("teamPicker");
  const usable = current.teams > 0;
  picker.classList.toggle("hidden", !usable);
  if (!usable) return;
  const mine = current.you ? current.you.team : -1;
  picker.querySelectorAll("[data-team]").forEach(button => {
    const raw = button.dataset.team;
    const on = raw === "auto" ? mine < 0 : Number(raw) === mine;
    button.classList.toggle("selected", on);
    button.setAttribute("aria-pressed", String(on));
    button.disabled = !canPickTeam();
  });
}

function renderNotes(current, mode) {
  const note = $("rosterNote");
  const enough = current.members.length + current.bots >= 2;
  // 刚闪过一次性提示就先让它把话说完，别立刻被例行文案盖掉。
  if (Date.now() < noteHoldUntil) {
    // 什么都不做
  } else if (overCapacity(current)) {
    note.textContent =
      `人太多了：现在 ${current.members.length} 人 + ${current.bots} 机器人，` +
      `而这间房最多带 ${current.capacity} 人 + ${current.maxBots} 机器人。` +
      `换回装得下的模式，或者请几位出去。`;
    note.classList.add("warn");
  } else if (!enough) {
    note.textContent = "至少要有两个参战者才能开打（加个机器人就行）";
    note.classList.add("warn");
  } else if (isHost()) {
    note.textContent = current.allReady
      ? "全员举手，可以开打了"
      : `还在等：${(current.pending || []).join("、")}`;
    note.classList.toggle("warn", !current.allReady);
  } else {
    note.textContent = current.you && current.you.ready ? "已举手，等房主开打…" : "点「我准备好了」，房主才能开打";
    note.classList.remove("warn");
  }
  const side = current.teams ? "自己选边，或交给系统自动分" : "各自为战";
  const join = current.join ? "对局中仍可加入" : "开打后谢客";
  $("teamNote").textContent =
    `${current.members.length} 名真人 + ${current.bots} 个机器人 · ${side} · ${join}`;
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

/** 服务端拒了一次我的动作：把它写在候场页看得见的地方。 */
export function flashRoomNote(text, warn = true) {
  noteHoldUntil = Date.now() + 6000;
  const note = $("rosterNote");
  note.textContent = text;
  note.classList.toggle("warn", warn);
}

/** 候场页可见时的兜底：服务端还没推过房间视图时，至少别让界面是空的。 */
export function ensureRoomVisible() {
  if (view) renderRoom(view);
}
