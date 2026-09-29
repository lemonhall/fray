/**
 * 房间的名册与权限：谁在房里、谁是房主、放几个机器人、能不能开局。
 *
 * 这一层是**纯函数**，不碰 storage、不碰 socket。理由很实际：房间权限是最容易
 * 出安全漏洞的地方（谁能踢人、谁能改人数、谁能开局），把它抽成纯函数之后，
 * 每一条规则都能用一个 assert 钉死，不用起 workerd。
 */

import { GADGETS, MODES } from "../sim/data.mjs";
import { clamp } from "../sim/constants.mjs";

export const PHASES = ["staging", "live", "over"];

/** 没给租户规则时的占位上限：比任何模式都大，但仍然是能写进 JSON 的普通数字。 */
const UNLIMITED = 99;

/**
 * 人数上限有两层：**租户规则**（这个租户允许开多大的局）和**模式上限**
 * （3v3 就是 6 个人，混战就是 10 个）。生效值取两者较小的那个，并且两个原值都留在
 * 状态里——否则从混战切回 3v3 再切回去，上限就会一路被"取最小"吃到只剩个位数。
 */
export function createRoomState({ tenant, roomId, name, mode = "control", difficulty = 1, bots = 4, hostId, hostName, maxHumans, maxBots, now = Date.now() }) {
  const cfg = MODES[mode] || MODES.control;
  const humansRule = Number.isFinite(maxHumans) ? Math.max(1, maxHumans) : UNLIMITED;
  const botsRule = Number.isFinite(maxBots) ? Math.max(0, maxBots) : UNLIMITED;
  return {
    tenant, roomId,
    name: (name || "新房间").slice(0, 24),
    mode: cfg.id, difficulty: clamp(Math.floor(difficulty), 0, 2),
    bots: clamp(Math.floor(bots), 0, Math.min(botsRule, cfg.bots)),
    hostId, hostName: hostName || "",
    phase: "staging",
    createdAt: now, updatedAt: now,
    humansRule, botsRule,
    maxHumans: Math.min(humansRule, cfg.maxHumans), maxBots: Math.min(botsRule, cfg.bots),
    members: [],
    lastSeed: 0, results: null, startedAt: 0, endedAt: 0,
  };
}

export const participantCap = state => MODES[state.mode].maxHumans + 0;

export function addMember(state, { playerId, name, hero = 0, gadget = "grenade", now = Date.now() }) {
  const existing = state.members.find(m => m.playerId === playerId);
  if (existing) {
    existing.name = name || existing.name;
    existing.hero = Number.isFinite(hero) ? hero : existing.hero;
    if (GADGETS[gadget]) existing.gadget = gadget;
    state.updatedAt = now;
    return { ok: true, member: existing, rejoined: true };
  }
  if (state.phase === "staging" && state.members.length >= state.maxHumans) {
    return { ok: false, error: "room_full" };
  }
  const member = {
    playerId,
    name: (name || "玩家").slice(0, 16),
    hero: clamp(Math.floor(hero), 0, 3),
    gadget: GADGETS[gadget] ? gadget : "grenade",
    ready: false, joinedAt: now,
  };
  state.members.push(member);
  if (!state.hostId || !state.members.some(m => m.playerId === state.hostId)) {
    state.hostId = playerId;
    state.hostName = member.name;
  }
  state.updatedAt = now;
  return { ok: true, member, rejoined: false };
}

export function removeMember(state, playerId, now = Date.now()) {
  const before = state.members.length;
  state.members = state.members.filter(m => m.playerId !== playerId);
  if (state.members.length === before) return false;
  if (state.hostId === playerId) {
    const next = [...state.members].sort((a, b) => a.joinedAt - b.joinedAt)[0];
    state.hostId = next ? next.playerId : "";
    state.hostName = next ? next.name : "";
  }
  state.updatedAt = now;
  return true;
}

export const isHost = (state, playerId) => !!playerId && state.hostId === playerId;

/** 换战术装置：每个人的装置是自己的事，房主也不能替别人选。 */
export function setMemberGadget(state, playerId, gadget, now = Date.now()) {
  const member = state.members.find(m => m.playerId === playerId);
  if (!member || !GADGETS[gadget]) return false;
  member.gadget = gadget;
  state.updatedAt = now;
  return true;
}

export function setBots(state, count, now = Date.now()) {
  state.bots = clamp(Math.floor(count), 0, state.maxBots);
  state.updatedAt = now;
  return state.bots;
}

export function setConfig(state, patch, now = Date.now()) {
  if (patch.name !== undefined) state.name = String(patch.name).slice(0, 24);
  if (patch.mode !== undefined && MODES[patch.mode]) {
    state.mode = patch.mode;
    const cfg = MODES[state.mode];
    state.maxHumans = Math.min(state.humansRule ?? cfg.maxHumans, cfg.maxHumans);
    state.maxBots = Math.min(state.botsRule ?? cfg.bots, cfg.bots);
    state.bots = Math.min(state.bots, state.maxBots);
  }
  if (patch.difficulty !== undefined) state.difficulty = clamp(Math.floor(patch.difficulty), 0, 2);
  state.updatedAt = now;
  return state;
}

/** 开局的准入条件：至少两名参战者，且不能被塞超过上限。 */
export function startCheck(state) {
  const total = state.members.length + state.bots;
  if (state.members.length < 1) return { ok: false, error: "no_players" };
  if (total < 2) return { ok: false, error: "need_two" };
  if (total > state.maxHumans + state.maxBots) return { ok: false, error: "too_many" };
  return { ok: true, total };
}

/** 给 Room 用的名册：人类在前（保证他们被分到对立两队），机器人补位。 */
export function rosterOf(state) {
  return state.members.map(m => ({
    kind: "human", ownerId: m.playerId, name: m.name, type: m.hero, gadget: m.gadget,
  }));
}

export function publicView(state) {
  return {
    id: state.roomId,
    name: state.name,
    mode: state.mode,
    modeName: MODES[state.mode].name,
    difficulty: state.difficulty,
    phase: state.phase,
    humans: state.members.length,
    bots: state.bots,
    capacity: MODES[state.mode].maxHumans,
    host: state.hostName,
    updatedAt: state.updatedAt,
  };
}

export function view(state, selfId) {
  const cfg = MODES[state.mode];
  return {
    t: "room",
    id: state.roomId,
    name: state.name,
    ph: state.phase,
    mode: state.mode,
    modeName: cfg.name,
    sub: cfg.sub,
    diff: state.difficulty,
    bots: state.bots,
    maxBots: state.maxBots,
    cap: state.maxHumans,
    capacity: cfg.maxHumans,
    host: state.hostId,
    startedAt: state.startedAt,
    members: state.members.map(m => ({
      id: m.playerId, n: m.name, hero: m.hero, g: m.gadget,
      rdy: m.ready ? 1 : 0, me: m.playerId === selfId ? 1 : 0,
    })),
    you: { id: selfId, host: isHost(state, selfId) },
    results: state.results,
  };
}
