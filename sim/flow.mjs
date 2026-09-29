/**
 * 对局流程：什么时候算结束、结束之后每个人排第几、拿多少奖励。
 *
 * 这个模块只读改写世界对象的标量字段，不 import 战斗逻辑，因此不会和
 * combat/actor 形成环依赖。
 */

import { clock } from "./constants.mjs";
import { PERKS, perkOf } from "./data.mjs";

export function contractsOf(w, a) {
  if (!a) return [];
  return [
    { name: "淘汰对手", value: a.kills, target: 3 },
    { name: "收集能量 / 空投", value: a.collected, target: 3 },
    w.mode === "control"
      ? { name: "累计占点", value: Math.floor(a.captureTime), target: 15, suffix: "s" }
      : { name: "对敌人造成伤害", value: Math.floor(a.damage), target: 6500 },
  ];
}

export function rewardOf(w, a, rank) {
  const completed = contractsOf(w, a).filter(c => c.value >= c.target).length;
  return 100 + a.kills * 25 + (rank === 1 ? 100 : 0) + (a.level - 1) * 15 + completed * 60;
}

/**
 * 结束一局。权威端负责算分，客户端只显示。
 * `w.phase` 从 `live` 走到 `over` 后，`stepWorld` 不再推进模拟，只剩结算。
 */
export function endMatch(w, reason = "score") {
  if (w.phase === "over") return;
  w.phase = "over";
  w.endedAt = w.time;
  w.endReason = reason;
  if (w.mode === "control") {
    const winner = w.score[0] > w.score[1] ? 0 : w.score[1] > w.score[0] ? 1 : -1;
    w.results = {
      kind: "control",
      winnerTeam: winner,
      score: [Math.floor(w.score[0]), Math.floor(w.score[1])],
      duration: clock(w.time),
      players: w.actors.map(a => summarize(w, a, a.team === winner ? 1 : 2)),
    };
  } else {
    const alive = w.actors.filter(a => a.alive).sort((x, y) => y.hp - x.hp);
    alive.forEach((a, i) => { a.rank = i + 1; });
    const winner = alive[0] || null;
    w.results = {
      kind: "survival",
      winnerActorId: winner ? winner.id : 0,
      duration: clock(w.time),
      players: w.actors.map(a => summarize(w, a, winner && a.id === winner.id ? 1 : a.rank || w.actors.length)),
    };
  }
}

function summarize(w, a, rank) {
  return {
    actorId: a.id,
    ownerId: a.ownerId,
    name: a.name,
    kind: a.kind,
    team: a.team,
    hero: a.type,
    rank,
    kills: a.kills,
    deaths: a.deaths,
    damage: Math.round(a.damage),
    collected: a.collected,
    capture: Math.floor(a.captureTime),
    level: a.level,
    alive: a.alive,
    reward: rewardOf(w, a, rank),
    build: PERKS.filter(p => perkOf(a, p.id)).map(p => ({ id: p.id, name: p.name, n: perkOf(a, p.id) })),
  };
}

/** 荒野生存：场上只剩最后一个活人时收局。 */
export function checkSurvivalEnd(w) {
  if (w.mode !== "survival" || w.phase !== "live") return false;
  const alive = w.actors.filter(a => a.alive);
  if (alive.length <= 1) { endMatch(w, "last-standing"); return true; }
  return false;
}
