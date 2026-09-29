/**
 * 一次性抽取工具：把桌面上的单机版 HTML 拆成"样式 + 标记"两份源文件。
 *
 * 只跑一次，产物提交进仓库（`web/index.html`、`web/styles/game.css`），
 * 之后 `tools/build.mjs` 只做复制。这样做的好处是构建不再依赖桌面上的那个文件，
 * 而原版的 CSS 与标记又做到了逐字节保留——那些手绘矢量精灵是一大笔资产，
 * 重写一遍只会把它弄丢。
 *
 * 输入是已有的 UTF-8 文件，输出显式写 UTF-8，不经过任何 shell 管道。
 */

import fs from "node:fs";
import path from "node:path";

const SOURCE = process.argv[2] || "C:/Users/lemon/Desktop/打枪加吃鸡.html";
const ROOT = path.resolve(import.meta.dirname, "..");

const text = fs.readFileSync(SOURCE, "utf8");
const slice = (from, to) => text.slice(text.indexOf(from) + from.length, text.indexOf(to));

const headPrelude = slice("<head>", "<style>")
  .replace(/<title>[\s\S]*?<\/title>/u, "");
const css = slice("<style>", "</style>");
const bodyMarkup = slice("<body>", "<script>");

const title = "<title>FRAY · 霓虹前线</title>\n";
const html = [
  "<!DOCTYPE html>",
  `<html lang="zh-CN">`,
  "<head>",
  headPrelude.trim(),
  title.trim(),
  '<link rel="stylesheet" href="/styles/game.css">',
  '<link rel="stylesheet" href="/styles/net.css">',
  "</head>",
  "<body>",
  bodyMarkup.trim(),
  '<script type="module" src="/js/app.mjs"></script>',
  "</body>",
  "</html>",
  "",
].join("\n");

fs.mkdirSync(path.join(ROOT, "web", "styles"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "web", "index.html"), html, "utf8");
fs.writeFileSync(path.join(ROOT, "web", "styles", "game.css"), `${css.trim()}\n`, "utf8");

console.log(`index.html  ${html.length} bytes`);
console.log(`game.css    ${css.length} bytes`);
