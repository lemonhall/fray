/**
 * 路由：没有框架，所以更要有测试。这里钉的是"参数怎么取、尾斜杠算不算同一个端点"。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { compile, createRouter } from "../src/router.mjs";

test("模式编译成带参数名的正则", () => {
  const { regex, keys } = compile("/v1/:tenant/rooms/:roomId/socket");
  assert.deepEqual(keys, ["tenant", "roomId"]);
  assert.equal(regex.test("/v1/neon/rooms/ABC123/socket"), true);
  assert.equal(regex.test("/v1/neon/rooms/ABC123/socket/extra"), false);
});

test("匹配器路由到对的处理器，并把 URL 编码还原", () => {
  const router = createRouter();
  const seen = [];
  router.get("/v1/health", () => "health");
  router.get("/v1/:tenant/rooms/:roomId", ({ params }) => params);
  router.post("/v1/:tenant/rooms", () => "created");
  const route = (method, path) => {
    const hit = router.match(method, path);
    if (!hit) return null;
    seen.push(hit.params);
    return { value: hit.handler({ params: hit.params }), params: hit.params };
  };

  assert.equal(route("GET", "/v1/health").value, "health");
  assert.equal(route("GET", "/v1/health/").value, "health", "尾斜杠是同一个端点");
  assert.deepEqual(route("GET", "/v1/neon/rooms/AB%2012").params, { tenant: "neon", roomId: "AB 12" });
  assert.equal(route("POST", "/v1/neon/rooms").value, "created");
  assert.equal(route("POST", "/v1/neon/rooms/ABC"), null, "方法不同就不算命中");
  assert.equal(route("GET", "/v1/neon/unknown"), null);
  assert.deepEqual(seen.length, 4);
});
