/**
 * 令牌：无状态 HMAC 的签发与验证，以及"租户凭据从哪取"。
 *
 * 这套东西的失效方式都很安静（验签放过一个过期令牌、或者把别人的租户令牌当自己的），
 * 所以宁可在这里多写几条断言。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { sha256Hex, randomKey, signToken, verifyToken, bearerOf } from "../src/auth.mjs";

const SECRET = "unit-test-secret";
const session = { tenantId: "neon", playerId: "g_1", name: "柠檬叔" };

test("sha256 十六进制与随机串", async () => {
  const hash = await sha256Hex("abc");
  assert.equal(hash, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.match(await sha256Hex("abc"), /^[0-9a-f]{64}$/u);
  assert.notEqual(randomKey(8), randomKey(8));
  assert.equal(randomKey(24).length, 32, "24 字节 base64url 后是 32 个字符");
});

test("签发 → 验证：拿得回租户、玩家与昵称", async () => {
  const token = await signToken(SECRET, session);
  const back = await verifyToken(SECRET, token);
  assert.deepEqual(back, session);
  assert.equal(token.includes("="), false, "base64url 不该带填充");
});

test("改一个字符就验不过；换个密钥也验不过；过期就作废", async () => {
  const token = await signToken(SECRET, session);
  const [body, sig] = token.split(".");
  const forgedBody = Buffer.from(`${session.tenantId}|g_evil|X|${Date.now() + 1000}`).toString("base64url");
  assert.equal(await verifyToken(SECRET, `${forgedBody}.${sig}`), null);
  assert.equal(await verifyToken("其他密钥", token), null);
  assert.equal(await verifyToken(SECRET, "not-a-token"), null);
  assert.equal(await verifyToken(SECRET, ""), null);
  assert.equal(await verifyToken(SECRET, body + "."), null);

  const shortLived = await signToken(SECRET, { ...session, ttlMs: -1000 });
  assert.equal(await verifyToken(SECRET, shortLived), null);
});

test("凭据优先从 Authorization 头取，其次才是查询串", () => {
  const request = headers => ({ headers: { get: key => headers[key.toLowerCase()] || null } });
  const url = new URL("https://example.com/v1/neon/rooms/AB/socket?token=from_query");
  assert.equal(bearerOf(request({ authorization: "Bearer abc" }), url), "abc");
  assert.equal(bearerOf(request({ authorization: "bearer abc" }), url), "abc");
  assert.equal(bearerOf(request({}), url), "from_query");
  assert.equal(bearerOf(request({ authorization: "Basic xyz" }), new URL("https://e.com/x")), "");
});
