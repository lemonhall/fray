/**
 * 房间浏览器：进站之后看到的第一屏。
 *
 * 它只做 HTTP：列房间、建房、快速匹配、看排行榜。真正的对局要走 WebSocket，
 * 而那条通道在 `app.mjs` 里才打开——"浏览"和"开打"是两件事，分开写才看得清。
 *
 * 房间列表用轮询（4 秒）而不是长连接：这是**刻意**的。列表刷新慢一点没人受伤，
 * 但为了它多维持一条常驻连接，会把这套东西的复杂度拉回十年前。
 */

import { TENANT, apiUrl } from "./config.mjs";
import { guestSession, listRooms, leaderboard, createRoom, quickMatch } from "./net.mjs";
import { createIdentityGate } from "./identity.mjs";
import { readName, writeName, ensureName } from "./namegate.mjs";
import { MODES } from "/sim/data.mjs";
import { S } from "./state.mjs";

const $ = id => document.getElementById(id);

let onJoin = () => {};
let timer = null;
let busy = false;
let nickTimer = null;
/**
 * 大厅里的提示语有一条"保留期"：玩家被房主踢出来、或者房间不让中途加入，
 * 都要把原因写在底部。而列表每 4 秒就会自己刷新一次并把提示覆盖掉——所以
 * 凡是"要让人看见"的提示，都在这段时间里不许被例行刷新冲走。
 */
let holdNoteUntil = 0;

export function nickname() {
  const typed = $("nickInput").value.trim();
  return (typed || S.playerName || readName() || "游客").slice(0, 16);
}

function setStatus(text, kind = "") {
  const pill = $("connPill");
  pill.classList.toggle("on", kind === "on");
  pill.classList.toggle("off", kind === "off");
  $("connText").textContent = text;
}

function setNote(text, error = false) {
  const note = $("roomsNote");
  note.textContent = text;
  note.classList.toggle("rooms-error", !!error);
}

/** 给别的模块用的"让人看见"的提示：踢人、房间谢客、开局被拒都会走这里。 */
export function notice(text, error = false) {
  holdNoteUntil = Date.now() + 8000;
  setNote(text, error);
}

/** 列房间 + 排行榜 + 最近战绩。失败时只在底部提示，不清空已有列表。 */
export async function refresh() {
  if (busy) return;
  busy = true;
  try {
    // 排行榜和最近战绩是**锦上添花**：它们挂了不该把"大厅连不上"这种话说给玩家听。
    // 真正必须成功的是房间列表——那才是能不能开一局的前提。
    const [rooms, board, matches] = await Promise.all([
      listRooms(), leaderboard(8).catch(() => ({ rows: [] })), recentMatches().catch(() => []),
    ]);
    renderRooms(rooms.rooms || []);
    renderBoard(board.rows || []);
    renderMatches(matches);
    setStatus(`已连接 · 租户 ${TENANT}`, "on");
    if (Date.now() > holdNoteUntil) {
      setNote(`房间列表每 4 秒自动刷新 · 当前 ${(rooms.rooms || []).length} 个房间`);
    }
  } catch (error) {
    setStatus("连不上后端", "off");
    setNote(`后端连接失败：${error.message}（检查 ?api= 指向的地址与租户 "${TENANT}" 是否已注册）`, true);
  } finally {
    busy = false;
  }
}

async function recentMatches() {
  const response = await fetch(apiUrl(`/v1/${encodeURIComponent(TENANT)}/matches?limit=8`));
  if (!response.ok) throw new Error(`matches_${response.status}`);
  return (await response.json()).matches || [];
}

function renderRooms(rooms) {
  const list = $("roomList");
  list.replaceChildren();
  if (!rooms.length) {
    const empty = document.createElement("div");
    empty.className = "rooms-empty";
    empty.textContent = "还没有房间。点右上角「创建房间」开一桌，或者直接快速匹配。";
    list.append(empty);
    return;
  }
  for (const room of rooms) list.append(card(room));
}

function card(room) {
  const mode = MODES[room.mode] || MODES.control;
  const el = document.createElement("button");
  el.type = "button";
  el.className = "room-card";
  el.dataset.room = room.id;
  const phase = room.phase === "live" ? ["live", "对局中"] : room.phase === "over" ? ["over", "结算中"] : ["", "准备中"];
  const humans = Number(room.humans) || 0;
  const capacity = Number(room.capacity) || mode.maxHumans;
  // 候场看"谁举手了"，对局中看"还收不收人"——两张卡片上最重要的信息是不同的。
  const flags = room.phase === "staging"
    ? `<span>举手 <b>${Number(room.ready) || 0}</b></span><span>待确认 <b>${Number(room.pending) || 0}</b></span>`
    : `<span class="${room.join ? "" : "flag-closed"}">${room.join ? "中途可加入" : "开打后谢客"}</span>`;
  el.innerHTML = `<header><div><h3></h3><div class="room-host"></div></div>` +
    `<span class="badge ${phase[0]}">${phase[1]}</span></header>` +
    `<div class="room-stats"><span>${mode.name} <b>${mode.sub}</b></span>` +
    `<span>真人 <b>${humans}/${capacity}</b></span><span>机器人 <b>${room.bots}</b></span></div>` +
    `<div class="room-flags">${flags}</div>` +
    `<div class="room-fill"><i style="width:${Math.round(humans / Math.max(1, capacity) * 100)}%"></i></div>` +
    `<span class="room-join">${room.phase === "live" ? (room.join ? "中途加入" : "不可加入") : "加入房间"} ↗</span>`;
  el.querySelector("h3").textContent = room.name;
  el.querySelector(".room-host").textContent = `房主 ${room.host || "—"} · 房间号 ${room.id}`;
  el.addEventListener("click", () => void joinRoomById(room.id));
  return el;
}

function renderBoard(rows) {
  const box = $("boardRows");
  box.replaceChildren();
  if (!rows.length) { box.append(row("还没有战绩", "打完一局就上榜")); return; }
  rows.forEach((r, i) => box.append(row(`${i + 1}. ${r.name || r.playerId}`, `${r.kills || 0} 击杀 · ${r.wins || 0} 胜 / ${r.games || 0} 场`)));
}

function renderMatches(matches) {
  const box = $("matchRows");
  box.replaceChildren();
  if (!matches.length) { box.append(row("还没有对局", "——")); return; }
  for (const m of matches.slice(0, 5)) {
    const winner = m.winner === "team:0" ? "蓝队" : m.winner === "team:1" ? "红队" : "混战";
    box.append(row(`${MODES[m.mode] ? MODES[m.mode].name : m.mode} · ${winner}`, `${mmss(m.durationMs)} · 房间 ${m.roomId}`));
  }
}

function row(main, sub) {
  const el = document.createElement("div");
  el.className = "side-row";
  const a = document.createElement("span"); a.textContent = main;
  const b = document.createElement("i"); b.textContent = sub;
  el.append(a, b);
  return el;
}

const mmss = ms => {
  const total = Math.max(0, Math.round((ms || 0) / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};

function readCreateForm() {
  return {
    name: $("createName").value.trim() || `${nickname()} 的房间`,
    mode: $("createMode").value,
    difficulty: Number($("createDifficulty").value) || 0,
    bots: Math.max(0, Math.min(9, Number($("createBots").value) || 0)),
    joinLive: $("createJoinLive").value === "1",
  };
}

/**
 * 进房前的统一仪式：**先有名字，再谈进门**。
 *
 * 名字不是装饰：它签在令牌里，服务端用它认人；空名字会让一屋子人全都叫"游客"，
 * 房主连"踢谁"都说不清。所以这里挡在门口问一次，问出来的名字顺手写进昵称框，
 * 后面 `ensureSession()` 自然会拿这个名字去重签令牌。
 */
async function gateName() {
  const name = await ensureName();
  if (name) {
    $("nickInput").value = name;
    // 名字是**签在令牌里**的，改完必须换一张新的。这里不能只靠 `ensureSession()`：
    // 身份闸门的 `ensure()` 只在"从没签过"时才动手，已经签过的那张会被当成有效令牌
    // 直接放行——表现就是"我明明起了名字，名册上还是旧的"。
    await connect();
    return true;
  }
  notice("没留名字就不放你进去——右上角随时可以改。", true);
  return false;
}

async function doCreate() {
  if (!(await gateName())) return;
  setNote("正在建房…");
  try {
    await ensureSession();
    const created = await createRoom(readCreateForm());
    $("createPanel").classList.add("hidden");
    onJoin(created.roomId);
  } catch (error) {
    setNote(`建房失败：${error.message}`, true);
  }
}

async function doQuickMatch() {
  if (!(await gateName())) return;
  setNote("正在寻找房间…");
  try {
    await ensureSession();
    const found = await quickMatch({ mode: $("createMode").value, difficulty: 1, bots: 4 });
    onJoin(found.roomId);
  } catch (error) {
    setNote(`快速匹配失败：${error.message}`, true);
  }
}

/** 点房间卡片进房：名字闸门 → 身份落定 → 交给上层开 socket。 */
export async function joinRoomById(roomId) {
  if (!(await gateName())) return;
  await ensureSession();
  onJoin(roomId);
}

/** 令牌落定之后，"我"是谁的**唯一**写入点。 */
const identity = createIdentityGate(data => {
  S.token = data.token;
  S.meId = data.playerId;
  S.playerName = data.name;
  S.tenant = data.tenant;
});

/**
 * 进站握手：拿一张游客令牌（名字只在真的变了才重签），顺带把房间列表拉出来。
 */
export async function connect() {
  const name = nickname();
  try {
    if (!identity.has() || name !== S.playerName) await identity.sign(name, guestSession);
    await refresh();
  } catch (error) {
    setStatus("身份获取失败", "off");
    setNote(`后端的租户 "${TENANT}" 还没注册，或者地址不对：${error.message}`, true);
  }
}

/**
 * 建房 / 快速匹配 / 进房之前的统一入口：**等身份落定**再动。
 * 少了这一步，就会出现"用旧令牌建房、用新令牌连 socket"这种错位——
 * 表现出来就是房主忽然没有房主权限。
 */
export async function ensureSession() {
  if (!(await identity.ensure(connect))) throw new Error("no_session");
  return S.token;
}

export function startAutoRefresh() {
  stopAutoRefresh();
  timer = setInterval(() => {
    if (S.screen === "rooms" && !document.hidden) void refresh();
  }, 4000);
}

export function stopAutoRefresh() {
  if (timer) clearInterval(timer);
  timer = null;
}

export function initRooms(hooks) {
  onJoin = hooks.onJoin;
  $("nickInput").value = readName() || "";
  $("nickInput").addEventListener("change", () => {
    writeName($("nickInput").value.trim());
    // 改名要换令牌（名字在令牌里），但别每次击键都签一张：抖动 400ms 合并掉，
    // 而且**只在大厅里**重签——对局中重签等于把"我"换成另一个人。
    clearTimeout(nickTimer);
    nickTimer = setTimeout(() => { if (S.screen === "rooms") void connect(); }, 400);
  });
  $("refreshRooms").addEventListener("click", () => void refresh());
  $("openCreateButton").addEventListener("click", () => $("createPanel").classList.toggle("hidden"));
  $("cancelCreate").addEventListener("click", () => $("createPanel").classList.add("hidden"));
  $("createRoomButton").addEventListener("click", () => void doCreate());
  $("quickMatchButton").addEventListener("click", () => void doQuickMatch());
  $("roomsHeadline").textContent = `选一个战场，或者自己开一桌`;
  return { connect, refresh, setStatus, setNote, joinRoomById };
}
