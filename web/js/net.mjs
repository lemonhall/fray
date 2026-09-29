/**
 * 网络层：REST 控制在 HTTP 上，对局在 WebSocket 上。
 *
 * 两条通道分开是有意的：房间列表、建房、排行榜是"请求-响应"，天然属于 HTTP；
 * 而一局对局是"持续双向的低延迟流"，属于 WebSocket。硬把两者塞进一条通道，
 * 换来的只是两边都别扭。
 */

import { apiUrl, TENANT } from "./config.mjs";
import { S } from "./state.mjs";

async function call(method, path, { body, token } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(apiUrl(path), {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || `http_${response.status}`), { status: response.status, data });
  return data;
}

export const tenantPath = suffix => `/v1/${encodeURIComponent(TENANT)}${suffix}`;

/**
 * 签一张游客令牌。**故意不往 `S` 里写**：什么时候把这张令牌当成"我"，
 * 是身份闸门（`identity.mjs`）的判断，不是网络层的副作用。写在这里的话，
 * 一张过期令牌也会覆盖掉新的那张。
 */
export const guestSession = name => call("POST", tenantPath("/guest"), { body: { name } });

export const listRooms = () => call("GET", tenantPath("/rooms"));
export const leaderboard = limit => call("GET", tenantPath(`/leaderboard?limit=${limit}`));
export const createRoom = config =>
  call("POST", tenantPath("/rooms"), { body: config, token: S.token });
export const quickMatch = config =>
  call("POST", tenantPath("/quickmatch"), { body: config, token: S.token });

/**
 * 开一条对局连接。所有服务端消息都通过 handlers 回调交给上层，
 * 网络层自己不认识"房间""对局"这些概念——它只负责收发与重连提示。
 */
export function openSocket(roomId, handlers = {}) {
  const base = apiUrl(tenantPath(`/rooms/${encodeURIComponent(roomId)}/socket`));
  const wsUrl = base.replace(/^http/u, "ws") + `?token=${encodeURIComponent(S.token)}`;
  const ws = new WebSocket(wsUrl);
  // `opened` 分得开两种"断了"：**握手就没成**（房间不存在、令牌不对、满员被拒）和
  // **进房之后才断**（网络抖了）。前者要说"这一间进不去"，后者才是"掉线了"——
  // WebSocket 的 API 不告诉我们会话是怎么失败的，这个布尔值是唯一的线索。
  let opened = false;
  ws.addEventListener("open", () => { opened = true; S.connected = true; handlers.onOpen?.(); });
  ws.addEventListener("close", () => { S.connected = false; handlers.onClose?.({ opened }); });
  ws.addEventListener("error", () => { S.connected = false; handlers.onError?.("socket_error"); });
  ws.addEventListener("message", event => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    handlers.onMessage?.(msg);
  });
  return {
    ws,
    send: payload => { if (ws.readyState === 1) ws.send(JSON.stringify(payload)); },
    close: () => { try { ws.close(); } catch { /* 已经关了 */ } },
  };
}

/** 心跳：既量 RTT，也顺便让服务端知道这条连接还活着。 */
export function startPing(link) {
  const timer = setInterval(() => {
    if (!S.connected) return;
    S.lastPingAt = performance.now();
    link.send({ t: "ping", id: S.seq++ });
  }, 2000);
  return () => clearInterval(timer);
}
