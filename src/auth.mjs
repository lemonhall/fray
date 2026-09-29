/**
 * 令牌与口令：租户 server key 的校验、玩家会话令牌的签发与验证。
 *
 * 会话令牌是**无状态**的：`HMAC(tenant|player|过期时间)`。它不是 JWT（没必要为
 * 一个字段引入一套标准），但它和 JWT 一样能在边缘直接验，不需要回源查库——
 * 这对"每 50ms 就要验一次连接的射击游戏"是必须的。
 */

const enc = new TextEncoder();

const b64url = bytes =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");

const unb64url = s => {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
};

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export function randomKey(bytes = 24) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return b64url(buf);
}

async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

/** 签发玩家会话令牌。`exp` 是绝对毫秒时间戳，写进载荷里，验签时一并检查。 */
export async function signToken(secret, { tenantId, playerId, name, ttlMs = 6 * 3600_000, now = Date.now() }) {
  const payload = `${tenantId}|${playerId}|${encodeURIComponent(name || "")}|${now + ttlMs}`;
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(payload));
  return `${b64url(enc.encode(payload))}.${b64url(sig)}`;
}

export async function verifyToken(secret, token, now = Date.now()) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const payload = new TextDecoder().decode(unb64url(body));
  const expected = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(payload));
  if (b64url(expected) !== sig) return null;
  const [tenantId, playerId, name, exp] = payload.split("|");
  if (!tenantId || !playerId || Number(exp) < now) return null;
  return { tenantId, playerId, name: decodeURIComponent(name || "") };
}

/** 从 `Authorization: Bearer xxx` / `?token=` 里取出凭据。 */
export function bearerOf(request, url) {
  const header = request.headers.get("authorization") || "";
  if (header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  return url.searchParams.get("token") || "";
}
