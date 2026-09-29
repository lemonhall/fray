/**
 * DOM 契约：前端脚本里 `$("xxx")` 提到的每个 id，index.html 里都必须真的存在。
 *
 * 为什么值得单独一个测试：这套前端有十几个模块跨文件引用同一份被抽取出来的标记，
 * 打错一个 id 在浏览器里只表现为"某个按钮点了没反应"，非常难查但极度容易发生。
 * 一条正则扫过去，就能在 `node --test` 阶段把它按住。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const html = readFileSync(path.join(ROOT, "web", "index.html"), "utf8");
const ids = new Set([...html.matchAll(/\sid="([^"]+)"/gu)].map(m => m[1]));

const modules = readdirSync(path.join(ROOT, "web", "js"))
  .filter(name => name.endsWith(".mjs"))
  .map(name => ({ name, source: readFileSync(path.join(ROOT, "web", "js", name), "utf8") }));

test("index.html 里有房间浏览器、候场名册与竞技场这三屏", () => {
  for (const id of ["rooms", "roomList", "createPanel", "roomBanner", "rosterPanel", "lobby", "arena", "results"]) {
    assert.ok(ids.has(id), `index.html 缺少 #${id}`);
  }
});

test("脚本引用的每一个 DOM id 都在标记里存在", () => {
  const missing = [];
  for (const { name, source } of modules) {
    for (const [, id] of source.matchAll(/\$\(\s*"([a-zA-Z][\w-]*)"\s*\)/gu)) {
      if (!ids.has(id)) missing.push(`${name} → #${id}`);
    }
    for (const [, id] of source.matchAll(/getElementById\(\s*"([a-zA-Z][\w-]*)"\s*\)/gu)) {
      if (!ids.has(id)) missing.push(`${name} → #${id}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("标记引用的样式表与脚本都真的存在", () => {
  const assets = [...html.matchAll(/(?:href|src)="(\/[^"]+)"/gu)].map(m => m[1]);
  assert.ok(assets.length >= 3);
  for (const asset of assets) {
    const file = path.join(ROOT, "web", asset.slice(1));
    assert.doesNotThrow(() => readFileSync(file), `静态资源缺失：${asset}`);
  }
});

test("共享内核的引用一律走 /sim/ 绝对路径，浏览器与服务端拿到的是同一份文件", () => {
  const bad = [];
  for (const { name, source } of modules) {
    for (const [, spec] of source.matchAll(/from\s+"(\.\.\/[^"]+)"/gu)) {
      bad.push(`${name} → ${spec}`);
    }
  }
  assert.deepEqual(bad, [], "前端模块只能从 /sim/ 或同目录引东西");
});
