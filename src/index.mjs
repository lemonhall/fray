/**
 * Worker 入口：HTTP 面 + WebSocket 转发。所有游戏逻辑都在 Durable Object 里。
 *
 * 这里只做四件事：认租户、认凭据、把请求路由到对的 DO、给浏览器补 CORS。
 * 有意不在这里做任何游戏判定——Worker 是无状态、可被复制到任何边缘节点的，
 * 把"谁赢了"这种判断放在这里，等于让它有多个互相看不见的副本。
 */

import { createRouter } from "./router.mjs";
import { getTenant, listTenants, createTenant, isServerKey, ensureSchema } from "./tenants.mjs";
import { signToken, verifyToken, bearerOf, randomKey } from "./auth.mjs";
import { recentMatches, leaderboard } from "./results.mjs";

export { Room } from "./room.mjs";
export { Lobby } from "./lobby.mjs";

const router = createRouter();
const tenantCache = new Map();
let schemaReady = null;

router.get("/v1/health", () => json({ ok: true, service: "fray", now: Date.now() }));

router.get("/v1/tenants", async ({ env }) => {
  await ready(env);
  return json({ tenants: await listTenants(env) });
});

router.post("/v1/tenants", async ({ request, env }) => {
  await ready(env);
  const key = bearerOf(request, new URL(request.url));
  if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) return json({ error: "forbidden" }, 403);
  const body = await bodyOf(request);
  if (!body.id) return json({ error: "id_required" }, 400);
  const created = await createTenant(env, { id: body.id, displayName: body.displayName });
  tenantCache.delete(created.id);
  return json(created, 201);
});

/** 浏览器入口：不需要任何密钥，直接发一张游客身份。 */
router.post("/v1/:tenant/guest", async ({ request, env, params }) => {
  await ready(env);
  const tenant = await loadTenant(env, params.tenant);
  if (!tenant) return json({ error: "unknown_tenant" }, 404);
  if (!tenant.rules.allowGuestSessions) return json({ error: "guest_disabled" }, 403);
  const body = await bodyOf(request);
  const playerId = `g_${randomKey(9)}`;
  const name = String(body.name || "游客").slice(0, 16);
  const token = await signToken(secretOf(env), { tenantId: tenant.id, playerId, name });
  return json({ playerId, name, token, tenant: tenant.id });
});

/** 服务端到服务端：游戏客户端把玩家 id 报上来，后端发一张带身份的令牌。 */
router.post("/v1/:tenant/sessions", async ({ request, env, params }) => {
  await ready(env);
  const tenant = await loadTenant(env, params.tenant);
  if (!tenant) return json({ error: "unknown_tenant" }, 404);
  const key = bearerOf(request, new URL(request.url));
  if (!(await isServerKey(env, tenant, key))) return json({ error: "forbidden" }, 403);
  const body = await bodyOf(request);
  if (!body.playerId) return json({ error: "playerId_required" }, 400);
  const token = await signToken(secretOf(env), {
    tenantId: tenant.id, playerId: String(body.playerId).slice(0, 64), name: String(body.name || body.playerId).slice(0, 16),
  });
  return json({ playerId: body.playerId, token });
});

router.get("/v1/:tenant/rooms", async ({ env, params }) => {
  await ready(env);
  const tenant = await loadTenant(env, params.tenant);
  if (!tenant) return json({ error: "unknown_tenant" }, 404);
  const rooms = await env.LOBBY.getByName(tenant.id).list();
  return json({ tenant: tenant.id, rooms });
});

router.post("/v1/:tenant/rooms", async ({ request, env, params }) => {
  await ready(env);
  const tenant = await loadTenant(env, params.tenant);
  if (!tenant) return json({ error: "unknown_tenant" }, 404);
  const session = await sessionOf(env, request, tenant.id);
  if (!session) return json({ error: "unauthorized" }, 401);
  const body = await bodyOf(request);
  const created = await env.LOBBY.getByName(tenant.id).create(roomConfig(tenant, body, session), tenant.rules.maxRooms);
  return created.ok ? json(created, 201) : json(created, 409);
});

router.post("/v1/:tenant/quickmatch", async ({ request, env, params }) => {
  await ready(env);
  const tenant = await loadTenant(env, params.tenant);
  if (!tenant) return json({ error: "unknown_tenant" }, 404);
  const session = await sessionOf(env, request, tenant.id);
  if (!session) return json({ error: "unauthorized" }, 401);
  const body = await bodyOf(request);
  const found = await env.LOBBY.getByName(tenant.id).quickMatch(roomConfig(tenant, body, session), tenant.rules.maxRooms);
  return found.ok ? json(found) : json(found, 409);
});

/** WebSocket：请求原样转给房间 DO，它自己验令牌、自己决定收不收。 */
router.get("/v1/:tenant/rooms/:roomId/socket", async ({ request, env, params }) => {
  await ready(env);
  const tenant = await loadTenant(env, params.tenant);
  if (!tenant) return json({ error: "unknown_tenant" }, 404);
  const stub = env.ROOM.getByName(`${tenant.id}:${params.roomId}`);
  if (!(await stub.info())) return json({ error: "unknown_room" }, 404);
  return stub.fetch(request);
});

router.get("/v1/:tenant/leaderboard", async ({ env, params, url }) => {
  await ready(env);
  const tenant = await loadTenant(env, params.tenant);
  if (!tenant) return json({ error: "unknown_tenant" }, 404);
  const limit = Math.min(50, Number(url.searchParams.get("limit")) || 20);
  return json({ tenant: tenant.id, rows: await leaderboard(env, tenant.id, limit) });
});

router.get("/v1/:tenant/matches", async ({ env, params, url }) => {
  await ready(env);
  const tenant = await loadTenant(env, params.tenant);
  if (!tenant) return json({ error: "unknown_tenant" }, 404);
  const limit = Math.min(30, Number(url.searchParams.get("limit")) || 12);
  return json({ tenant: tenant.id, matches: await recentMatches(env, tenant.id, limit) });
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });
    const hit = router.match(request.method, url.pathname);
    if (!hit) {
      // 非 API 路径交给静态资源绑定（本地开发时同一个 Worker 顺便把前端也发了）。
      if (env.ASSETS && !url.pathname.startsWith("/v1/")) return env.ASSETS.fetch(request);
      return json({ error: "not_found", path: url.pathname }, 404);
    }
    try {
      const response = await hit.handler({ request, env, params: hit.params, url });
      // WebSocket 升级响应（101）的 header 是**只读**的——往上写 CORS 会直接抛异常，
      // 表现为"握手 500"，而真正的错误信息藏在 body 里，很难猜。所以这里显式跳过。
      if (response.status !== 101) for (const [k, v] of Object.entries(cors())) response.headers.set(k, v);
      return response;
    } catch (error) {
      return json({ error: "internal", message: String(error && error.message || error) }, 500);
    }
  },
};

const json = (data, status = 200) => Response.json(data, { status, headers: cors() });
const cors = () => ({
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,content-type",
  "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
});

async function bodyOf(request) {
  try { return (await request.json()) || {}; } catch { return {}; }
}

function secretOf(env) {
  if (!env.SESSION_SECRET) throw new Error("SESSION_SECRET is not configured");
  return env.SESSION_SECRET;
}

async function sessionOf(env, request, tenantId) {
  const session = await verifyToken(secretOf(env), bearerOf(request, new URL(request.url)));
  return session && session.tenantId === tenantId ? session : null;
}

async function ready(env) {
  if (!schemaReady) schemaReady = ensureSchema(env).catch(err => { schemaReady = null; throw err; });
  await schemaReady;
}

/** 租户查表加一层 60 秒缓存：每个请求都打一次 D1 是纯浪费。 */
async function loadTenant(env, id) {
  const cached = tenantCache.get(id);
  if (cached && Date.now() - cached.at < 60_000) return cached.tenant;
  const tenant = await getTenant(env, id);
  if (tenant) tenantCache.set(id, { tenant, at: Date.now() });
  return tenant;
}

function roomConfig(tenant, body, session) {
  const rules = tenant.rules;
  return {
    tenant: tenant.id,
    name: String(body.name || `${session.name} 的房间`).slice(0, 24),
    mode: body.mode === "survival" ? "survival" : "control",
    difficulty: Number(body.difficulty) || 0,
    bots: Math.max(0, Math.min(rules.maxBotsPerRoom, Number(body.bots) ?? 4)),
    // 建房表单里的"允许中途加入"。缺省为开——这就是改版前的行为，不能让老客户端
    // 因为少传一个字段就忽然进不去正在打的房间。
    joinLive: body.joinLive !== false,
    hostId: session.playerId,
    hostName: session.name,
    maxHumans: rules.maxHumansPerRoom,
    maxBots: rules.maxBotsPerRoom,
  };
}
