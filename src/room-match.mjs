/**
 * 一局比赛的"开、进、退"：把名册变成场上的实体，以及中途进出的人怎么落位。
 *
 * 与 `room-state.mjs` 的分工：那边管**名册**（谁在房里、谁是房主），
 * 这边管**场上**（谁在哪、属于哪队、有没有实体）。两边都只吃普通对象。
 */

import { DT } from "../sim/constants.mjs";
import { MODES } from "../sim/data.mjs";
import { createWorld, startMatch, fillRoster } from "../sim/world.mjs";
import { newActor } from "../sim/actor.mjs";
import { findOpen, spawnPoints } from "../sim/map.mjs";
import { encodeMap } from "../sim/wire.mjs";
import { stepWorld } from "../sim/step.mjs";
import { rosterOf } from "./room-state.mjs";

/** 开一局新的：换种子、重铺地图、重排出生点。房主点一次"开始"就走到这里。 */
export function beginMatch(state, now = Date.now()) {
  const seed = randomSeed();
  const world = createWorld({
    tenant: state.tenant, roomId: state.roomId,
    mode: state.mode, difficulty: state.difficulty, seed,
  });
  startMatch(world, fillRoster(world, rosterOf(state), state.bots), seed);
  state.phase = "live";
  state.lastSeed = seed;
  state.startedAt = now;
  state.results = null;
  return { world, mapMsg: encodeMap(world) };
}

/** 重开一局（结算之后房主点"再来一局"）。 */
export function resetMatch(state, world) {
  state.phase = "staging";
  state.results = null;
  state.startedAt = 0;
  if (world) { world.phase = "staging"; world.actors = []; }
}

/**
 * 对局进行中有人进来：直接给他一个实体丢进场。
 *
 * 这是刻意做的选择——观众席那种"先等着"对一个小体量 demo 只会增加概念负担，
 * 而"随时能进场补位"恰好是房主放机器人这个设定天然能兜住的。
 */
export function joinLive(world, member) {
  if (!world || world.phase !== "live") return null;
  if (world.actors.some(a => a.ownerId === member.playerId)) return null;
  const team = pickTeam(world);
  const index = world.actors.length;
  const [sx, sy] = spawnPoints(world, index, index + 1);
  const p = findOpen(world, sx, sy);
  const actor = newActor(world, {
    id: world.nextEntity++, kind: "human", ownerId: member.playerId,
    type: member.hero, gadget: member.gadget, x: p.x, y: p.y, team, name: member.name,
  });
  world.actors.push(actor);
  return actor;
}

/**
 * 掉线：只清掉最后一次输入。
 *
 * 刻意**不**把角色从场上拿掉——那样会让"重连"变成一个需要重放名额的复杂状态机。
 * 角色留在原地挨打（热点争夺里还会按既有规则重生），重连上来接着用同一个实体。
 */
export function dropPlayer(world, playerId) {
  if (!world) return;
  const actor = world.actors.find(a => a.ownerId === playerId);
  if (actor) actor.input = null;
}

export function actorIdOf(world, playerId) {
  const a = world?.actors.find(x => x.ownerId === playerId);
  return a ? a.id : 0;
}

function pickTeam(world) {
  if (world.mode !== "control") return world.actors.length;
  const alive = [0, 0];
  for (const a of world.actors) if (a.alive) alive[a.team]++;
  return alive[0] <= alive[1] ? 0 : 1;
}

function randomSeed() {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] || 1;
}

/** 快进：从一个 tick 推到目标 tick，带补算上限，防止长时间挂起后把 CPU 打满。 */
export function advanceWorld(world, lastTickMs, now, maxTicks) {
  if (!world || world.phase !== "live") return lastTickMs;
  const stepMs = 1000 / 60;
  let steps = Math.floor((now - lastTickMs) / stepMs);
  if (steps <= 0) return lastTickMs;
  // 超预算就丢掉积压的时间（世界比墙上时钟走得慢一点），而不是把债务滚雪球，
  // 否则一次长时间的挂起会让后续每一帧都在补算，CPU 永远降不下来。
  let base = lastTickMs + steps * stepMs;
  if (steps > maxTicks) { steps = maxTicks; base = now; }
  for (let i = 0; i < steps; i++) {
    if (world.phase !== "live") break;
    stepWorld(world, DT);
  }
  return base;
}

export const modeOf = m => MODES[m] || MODES.control;
