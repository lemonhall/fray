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
import { resetQueue } from "../sim/netcode.mjs";
import { rosterOf, clearReady } from "./room-state.mjs";

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
  // 回到候场就得重新举手：上一局开打前的那次 ready 不能顺延到下一局，
  // 否则房主可以对着"全都没动过"的名册直接再开一局，等于把确认又变成了摆设。
  clearReady(state);
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
  // 中途进来的人，自己选的边优先（还是那句话：想和朋友一队是合理的），
  // 没选过才按场上人数自动补。
  const chosen = member.team === 0 || member.team === 1 ? member.team : null;
  const team = chosen !== null && world.mode === "control" ? chosen : pickTeam(world);
  makeRoom(world, team);
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
 * 场上满了就先挪走一个机器人：**真人进来占掉机器人名额**——建房的提示里就是这么
 * 写的，机器人本来就是拿来补位的。不做这一步的话，3v3 会在补位时变成 4v3、4v4，
 * "最多几个人"这件事就没有一处是准的。
 *
 * 挑谁？优先同一队、优先**已经倒下**的那个（少影响一个正在打的）。一个都挑不出
 * （场上全是真人）就直接算了，宁可超编也不赶真人。
 */
function makeRoom(world, team) {
  const cap = (MODES[world.mode] || MODES.control).maxHumans;
  if (world.actors.length < cap) return;
  const bots = world.actors.filter(a => a.kind !== "human");
  const sameTeam = bots.filter(a => a.team === team);
  const pool = sameTeam.length ? sameTeam : bots;
  if (!pool.length) return;
  const victim = [...pool].sort((a, b) => Number(a.alive) - Number(b.alive))[0];
  world.actors = world.actors.filter(a => a !== victim);
}

/**
 * 把人从场上**彻底拿掉**（踢人用）。
 *
 * 和 `dropPlayer`（掉线）刻意分开：掉线的人只是失去输入，角色留在原地挨打，
 * 回来还能接着用；被踢的人是真被请走了，留着一个不动的角色只会让大家以为他挂机。
 */
export function ejectFromWorld(world, playerId) {
  if (!world) return false;
  const before = world.actors.length;
  world.actors = world.actors.filter(a => a.ownerId !== playerId);
  return world.actors.length !== before;
}

/**
 * 掉线：清掉还没消化的输入命令。
 *
 * 刻意**不**把角色从场上拿掉——那样会让"重连"变成一个需要重放名额的复杂状态机。
 * 角色留在原地挨打（热点争夺里还会按既有规则重生），重连上来接着用同一个实体。
 * 但命令队列必须清空：那是"我接下来还要往哪走"的债，人不在了就不该继续走。
 */
export function dropPlayer(world, playerId) {
  if (!world) return;
  const actor = world.actors.find(a => a.ownerId === playerId);
  if (actor) resetQueue(actor);
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

/**
 * 快进：把世界推进到"现在"。
 *
 * **这个函数保证世界的平均推进速度和墙上时钟一致**，这一点是画面平滑的根。原来
 * 它每次只算 `floor(经过时间 / 16.67ms)` 步，剩下那不足一格的零头**直接扔掉**：
 * 消息每 40ms 来一条时，每次丢 0~16ms，平均世界时间比真实时间慢百分之十几。
 * 客户端按真实时间插值，于是它的"渲染头"一会儿追过服务端的数据（只能冻住等），
 * 一会儿又被新的快照拽回去——眼睛看到的就是**幻灯片**。
 *
 * 修法是把零头**记账**：累积到 `world.stepCarry`，够一格就走一步。这样世界既不
 * 丢时间（不会比真时间慢），也不会滚雪球（不会一次补出几百步）。
 * `maxTicks` 仍然保留，只用来防止一次长时间的挂起把 CPU 打满。
 */
export function advanceWorld(world, lastTickMs, now, maxTicks) {
  if (!world || world.phase !== "live") return lastTickMs;
  const stepMs = 1000 / 60;
  const elapsed = now - lastTickMs;
  if (elapsed <= 0) return lastTickMs;
  const total = (world.stepCarry || 0) + elapsed;
  let steps = Math.floor(total / stepMs);
  if (steps <= 0) { world.stepCarry = total; return now; }
  // 超预算只削掉**这一步**要补的量，剩下的零头照记——削掉的是"这一次的欠账"，
  // 而不是"世界该有的时间"。两者混为一谈就会重新开始丢时间。
  const extra = Math.max(0, steps - maxTicks);
  steps = Math.min(steps, maxTicks);
  world.stepCarry = total - (steps + extra) * stepMs;
  for (let i = 0; i < steps; i++) {
    if (world.phase !== "live") break;
    stepWorld(world, DT);
  }
  return now;
}

export const modeOf = m => MODES[m] || MODES.control;

/**
 * 节拍网格的**纯算术部分**：该不该在这一刻发牌，世界要推进到哪一刻，下一拍排在哪。
 *
 * 抽出来单独一个函数有两个理由：`room.mjs` 那个 Durable Object 在 Node 里根本起不来
 * （`cloudflare:workers` 不存在），而这里恰恰是最容易写错、最值得钉死的一段算术；
 * 而且"网格"这个概念本身跟 WebSocket、跟 DO 都没关系，它只是"时间怎么对齐"。
 *
 * 约定：
 *   - 未开始（`nextBcastMs` 为 0）→ 以 `now` 为原点，返回第一拍的时刻；
 *   - 没到点 → 返回 `null`，调用方什么都不做；
 *   - 到点（包括晚到）→ `target` 是**网格上应该到的时刻**（永远 ≤ `now`），世界推到
 *     那里为止；`skipped` 是中间被跳掉的格子数（DO 被冻了一会儿）。跳过的格子只丢
 *     快照、**不丢世界时间**，否则世界会比墙上时钟永久落后。
 */
export function beatGrid({ now, nextBcastMs, broadcastMs = 50 }) {
  if (!nextBcastMs) return { target: now, next: now + broadcastMs, skipped: 0, started: true };
  if (now < nextBcastMs) return null;
  const skipped = Math.floor((now - nextBcastMs) / broadcastMs);
  const target = nextBcastMs + skipped * broadcastMs;
  return { target, next: target + broadcastMs, skipped, started: false };
}

/**
 * "这个房间该不该回收"——和 `beatGrid` 一样抽成纯函数，因为它是**破坏性**的那一步
 * （回收会把名册清空、把对局扔掉），而 `room.mjs` 在 Node 里起不来（`cloudflare:workers`）。
 *
 * 两条判据，缺一不可：
 *   - `empty`：一个连接都没有了。正常退房走的都是这一条；
 *   - `silent`：还有连接，但**整整 `idleMs` 没有收到过任何消息**。客户端 2 秒一个心跳，
 *     所以这只会命中"连接其实是僵尸"的情况。
 *
 * 曾经用 `state.updatedAt`（名册最后变动时间）当判据，那是错的：一局从头打到尾
 * 名册一次都不动，于是对局进行到第 10 分钟，房间会被自己的 alarm 拆掉——名册清空、
 * 世界扔掉，而玩家还连着、还在打。
 */
export function reclaimReason({ conns = 0, lastMsgMs = 0, now = 0, idleMs = 30 * 60_000 }) {
  if (conns <= 0) return "empty";
  if (lastMsgMs && now - lastMsgMs > idleMs) return "silent";
  return "";
}
