/**
 * 战绩落库与排行榜（D1）。
 *
 * 一场打完写一行，`stats` 里存每个参战者的 JSON 数组。排行榜直接在这份 JSON 上
 * 用 SQLite 的 json_each 聚合——不额外建一张明细表，是因为"一场比赛的参战者"
 * 本来就只在这一个场景里被读，为它做范式化只会多一次 JOIN 和一份同步负担。
 */

export async function recordMatch(env, state, world) {
  const results = state.results;
  if (!results) return null;
  const id = `${state.tenant}:${state.roomId}:${state.startedAt}`;
  const winner = results.kind === "control"
    ? `team:${results.winnerTeam}`
    : `player:${(results.players.find(p => p.rank === 1) || {}).ownerId || ""}`;
  await env.DB.prepare(
    `INSERT OR REPLACE INTO matches
       (id, tenant_id, room_id, mode, seed, started_at, ended_at, duration_ms, winner, stats)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id, state.tenant, state.roomId, state.mode, state.lastSeed,
    state.startedAt, state.endedAt, Math.max(0, state.endedAt - state.startedAt),
    winner, JSON.stringify(results.players),
  ).run();
  return id;
}

export async function recentMatches(env, tenantId, limit = 12) {
  const { results } = await env.DB.prepare(
    `SELECT id, room_id, mode, started_at, ended_at, duration_ms, winner, stats
       FROM matches WHERE tenant_id = ? ORDER BY ended_at DESC LIMIT ?`,
  ).bind(tenantId, limit).all();
  return (results || []).map(r => ({
    id: r.id, roomId: r.room_id, mode: r.mode, startedAt: r.started_at,
    endedAt: r.ended_at, durationMs: r.duration_ms, winner: r.winner,
    players: safeParse(r.stats),
  }));
}

/** 只统计人类玩家：机器人上榜会把榜单一夜之间刷成机器人名字。 */
export async function leaderboard(env, tenantId, limit = 20) {
  const { results } = await env.DB.prepare(
    `SELECT json_extract(j.value, '$.ownerId') AS playerId,
            json_extract(j.value, '$.name')    AS name,
            COUNT(*)                           AS games,
            SUM(json_extract(j.value, '$.kills'))   AS kills,
            SUM(json_extract(j.value, '$.deaths'))  AS deaths,
            SUM(json_extract(j.value, '$.reward'))  AS xp,
            SUM(CASE WHEN json_extract(j.value, '$.rank') = 1 THEN 1 ELSE 0 END) AS wins
       FROM matches, json_each(matches.stats) j
      WHERE matches.tenant_id = ?
        AND json_extract(j.value, '$.kind') = 'human'
        AND json_extract(j.value, '$.ownerId') NOT LIKE 'bot:%'
      GROUP BY playerId
      ORDER BY kills DESC, wins DESC
      LIMIT ?`,
  ).bind(tenantId, limit).all();
  return results || [];
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return []; }
}
