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

export async function guestSession(name) {
  const data = await call("POST", tenantPath("/guest"), { body: { name } });
  S.token = data.token;
  S.meId = data.playerId;
  S.playerName = data.name;
  S.tenant = data.tenant;
  return data;
}

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
  ws.addEventListener("open", () => { S.connected = true; handlers.onOpen?.(); });
  ws.addEventListener("close", () => { S.connected = false; handlers.onClose?.(); });
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
