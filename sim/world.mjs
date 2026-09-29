/**
 * 世界对象：一局对局的全部权威状态。
 *
 * 它是**纯数据 + 纯函数**能拼出的最大单位，不持有 socket、不持有定时器、
 * 不知道自己在 Durable Object 里还是在浏览器里跑。这条边界让"同一份代码跑两边"
 * 成为可能，也让 90% 的测试可以用纯函数的方式写完。
 */

import { WORLD, clamp, distance } from "./constants.mjs";
import { MODES, BOT_NAMES, HEROS } from "./data.mjs";
import { buildMap, findOpen, spawnPoints } from "./map.mjs";
import { newActor } from "./actor.mjs";

export function createWorld({ tenant, roomId, mode = "control", difficulty = 1, seed = 1 }) {
  const w = {
    tenant, roomId,
    mode: MODES[mode] ? mode : "control",
    difficulty: clamp(Math.floor(difficulty), 0, 2),
    // `seed` 是**会变的** LCG 状态（每取一次随机数就往前推一格），
    // `matchSeed` 才是一局的身份：地图、表现层随机、战绩落库都用它。
    // 混用这两个会让"同一局的地图种子"随对局进程漂移，是个很难查的坑。
    seed: seed >>> 0, matchSeed: seed >>> 0,
    phase: "staging",
    time: 0, tick: 0, nextEntity: 1,
    actors: [], bullets: [], cubes: [], grenades: [], fields: [], supplies: [], scheduled: [],
    events: [],
    grid: [], walls: [], bushes: [], boxes: [],
    score: [0, 0],
    zone: { x: WORLD / 2, y: WORLD / 2, r: 158, owner: -1, contested: false },
    ring: { x: WORLD / 2, y: WORLD / 2, r: 9999 },
    nextSupply: 20, supplyInterval: 32, lastZoneIndex: 0,
    results: null, endedAt: 0, endReason: "",
  };
  return w;
}

/**
 * 把名册落成场上的实体。这是 `staging → live` 的唯一入口。
 *
 * 名册来自 Room 的 `staging` 阶段：人类玩家按加入顺序，机器人由房主投放。
 * 队伍分配刻意让**前两个人类玩家分属两队**——这才保证"一定能对枪"，
 * 而不是像单机版那样永远是人打 AI。
 */
export function startMatch(w, roster, seed) {
  w.seed = (seed >>> 0) || w.seed;
  w.matchSeed = w.seed;
  w.time = 0; w.tick = 0; w.phase = "live";
  w.bullets = []; w.cubes = []; w.grenades = []; w.fields = []; w.supplies = []; w.scheduled = [];
  w.events = []; w.score = [0, 0]; w.results = null; w.endedAt = 0; w.endReason = "";
  w.zone = { x: WORLD / 2, y: WORLD / 2, r: 158, owner: -1, contested: false };
  w.ring = { x: WORLD / 2, y: WORLD / 2, r: w.mode === "control" ? 9999 : 1420 };
  w.nextSupply = 20; w.lastZoneIndex = 0;
  buildMap(w);
  w.actors = [];
  const placed = assignTeams(w, roster);
  placed.forEach((entry, i) => {
    const [sx, sy] = spawnPoints(w, entry.spawnIndex, placed.length);
    const p = findOpen(w, sx, sy);
    const actor = newActor(w, {
      id: w.nextEntity++, kind: entry.kind, ownerId: entry.ownerId, type: entry.type,
      x: p.x, y: p.y, team: entry.team, name: entry.name, gadget: entry.gadget,
    });
    w.actors.push(actor);
  });
  // 出生点周围清空箱子，避免一出生就被卡住。
  w.boxes = w.boxes.filter(b => !w.actors.some(a => distance(a, b) < 78));
  return w;
}

/** 队伍与出生点分配。人类玩家优先，且互相分到对立面。 */
function assignTeams(w, roster) {
  const humans = roster.filter(r => r.kind === "human");
  const bots = roster.filter(r => r.kind !== "human");
  if (w.mode !== "control") {
    return [...humans, ...bots].map((r, i) => ({ ...r, team: i, spawnIndex: i }));
  }
  const slots = 6;
  const out = humans.slice(0, slots).map((r, i) => ({ ...r, team: i % 2, spawnIndex: 0 }));
  const counts = [0, 0];
  for (const e of out) counts[e.team]++;
  for (const b of bots) {
    if (out.length >= slots) break;
    const team = counts[0] <= counts[1] ? 0 : 1;
    counts[team]++;
    out.push({ ...b, team, spawnIndex: 0 });
  }
  const cursor = [0, 0];
  for (const e of out) {
    // 热点争夺的地图是上下镜像的：0/1/2 是下方（蓝），3/4/5 是上方（红）。
    e.spawnIndex = (e.team === 0 ? 0 : 3) + cursor[e.team]++;
  }
  return out;
}

/** 机器人补位：房间不足时把空位填满，保证"一个人也打得起来"。 */
export function fillRoster(w, roster, botCount) {
  const cap = MODES[w.mode] ? (w.mode === "control" ? 6 : 10) : 6;
  const humans = roster.filter(r => r.kind === "human");
  const botsWanted = clamp(botCount, 0, Math.max(0, cap - humans.length));
  const out = humans.map(h => ({ ...h }));
  for (let i = 0; i < botsWanted; i++) {
    out.push({
      kind: "bot", ownerId: `bot:${i}`,
      name: BOT_NAMES[(humans.length + i) % BOT_NAMES.length] + (i >= BOT_NAMES.length ? `·${Math.floor(i / BOT_NAMES.length)}` : ""),
      type: (i + humans.length) % HEROS.length,
    });
  }
  return out;
}
