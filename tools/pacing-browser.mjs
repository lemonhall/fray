/**
 * 浏览器版节奏探针：**量玩家眼睛里看到的那个数**。
 *
 * 和 `pacing-probe.mjs`（纯 Node 的 WebSocket 客户端）的区别：那个量的是"服务器和链路
 * 怎么发"，这个量的是"浏览器**收到并渲染**成什么样"。两者的差值很有信息量：
 *   - Node 探针干净、浏览器探针卡 → 是自己的前端代码有问题；
 *   - 两个都卡、而两边的事件循环都没停 → 那就是跨境链路在成串地投递，跟代码无关。
 *
 * 做法：开一个真浏览器，建房、放机器人、开打，然后把 `S.snaps.push` 打个补丁，把
 * **每张快照到达的 `performance.now()` 和它的世界时间 `tm`** 记下来。拿到的序列
 * 可以直接喂给 `head-diag`（`.fray-scratch/head-diag.mjs`）重算渲染头的推进。
 *
 * 用法：
 *   node tools/pacing-browser.mjs                       # 打线上（https://fray.lemonhall.me）
 *   E2E_BASE=http://127.0.0.1:8790 node tools/pacing-browser.mjs
 *   E2E_HEADED=1 node tools/pacing-browser.mjs          # 想看着它跑
 *
 * 需要 Playwright + 本机 Chrome，路径给法同 `tools/e2e-local.mjs`。
 */

/** 先按常规解析；找不到再试用户给的全局 node_modules。 */
async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch (error) {
    const dir = process.env.E2E_PLAYWRIGHT_DIR;
    if (!dir) throw new Error(`解析不到 playwright（${error.message}）`);
    return import(new URL("playwright/index.mjs", `file:///${dir.replace(/\\/gu, "/").replace(/\/?$/u, "/")}`).href);
  }
}

const { chromium } = await loadPlaywright();
const BASE = process.env.E2E_BASE || "https://fray.lemonhall.me";
const SECONDS = Number(process.env.PACE_SECONDS ?? 20);
const OUT = process.env.PACE_DUMP || "";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(fn, { timeout = 30000, every = 250, what = "条件" } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(every);
  }
  throw new Error(`等待超时：${what}`);
}

const observe = page => page.evaluate(async () => {
  const { S } = await import("/js/state.mjs");
  return {
    screen: S.screen,
    tenant: S.tenant,
    seed: S.map ? S.map.seed : null,
    snaps: S.snaps.length,
    connText: (document.getElementById("connText") || {}).textContent || "",
  };
});

const browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", error => console.log(`  [页面报错] ${error.message}`));
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.fill("#nickInput", "节奏观察员");
  await page.dispatchEvent("#nickInput", "change");
  await until(async () => (await observe(page)).connText.includes("已连接"), { what: "拿到会话" });

  await page.click("#openCreateButton");
  await page.fill("#createName", "节奏测量");
  await page.selectOption("#createMode", "control");
  await page.fill("#createBots", "5");
  await page.click("#createRoomButton");
  await until(async () => (await observe(page)).screen === "staging", { what: "进入候场" });
  await page.click("#startButton");
  await until(async () => (await observe(page)).seed, { what: "拿到地图" });

  // 打补丁：记下每一张快照的到达时刻与它的世界时间。
  await page.evaluate(async () => {
    const { S } = await import("/js/state.mjs");
    window.__pace = [];
    const push = S.snaps.push.bind(S.snaps);
    S.snaps.push = snap => { window.__pace.push([performance.now(), snap.tm, snap.tk]); return push(snap); };
  });
  console.log(`—— 采集中：${SECONDS} 秒（${BASE}）——`);
  await sleep(SECONDS * 1000);
  const rows = await page.evaluate(() => window.__pace);

  const arrival = [], world = [];
  for (let i = 1; i < rows.length; i++) {
    arrival.push(rows[i][0] - rows[i - 1][0]);
    world.push((rows[i][1] - rows[i - 1][1]) * 1000);
  }
  const q = (arr, p) => [...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(p * arr.length))] || 0;
  const buckets = {};
  for (const v of arrival) { const k = Math.round(v / 20) * 20; buckets[k] = (buckets[k] || 0) + 1; }
  const report = {
    base: BASE,
    seconds: SECONDS,
    snapshots: rows.length,
    arrivalMs: { median: Math.round(q(arrival, .5)), p95: Math.round(q(arrival, .95)), max: Math.round(Math.max(...arrival)) },
    arrivalBuckets: buckets,
    worldMs: { median: Math.round(q(world, .5)), p95: Math.round(q(world, .95)), min: Math.round(Math.min(...world)) },
    // 一次到达里"成串"来了几张：≥2 说明链路在攒包，客户端只能等下一串。
    burst: arrival.filter(v => v < 20).length,
    stalls: arrival.filter(v => v > 200).map(v => Math.round(v)),
  };
  console.log(JSON.stringify(report, null, 2));
  if (OUT) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(OUT, JSON.stringify(rows.map(r => [Math.round(r[0]), r[1], r[2]])));
    console.log(`已写出 ${OUT}（可喂给 head-diag）`);
  }
} finally {
  await browser.close();
}
