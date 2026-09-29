/**
 * 浏览器联调的脚手架：起 Chrome、读页面状态、等条件成立、像人一样按键。
 *
 * 从 `e2e-local.mjs` 里拆出来，是因为那个文件一路顶到了 300 行以上——而它真正
 * 有价值的部分是**场景**（一局比赛从头到尾发生了什么），不是这些机械动作。
 * 拆开之后，"怎么测"和"测什么"各占一个文件，读的人两分钟能看完场景。
 *
 * 需要 Playwright 与本机 Chrome（用 `channel:"chrome"`，所以**不下载**它自带的
 * 那几百兆浏览器）。Playwright 装在本仓库 (`npm i -D playwright`) 或全局都行：
 * 全局装的话给它指个路 —— `E2E_PLAYWRIGHT_DIR=/path/to/node_modules`。
 */

export const BASE = (process.env.E2E_BASE || "http://127.0.0.1:8790").replace(/\/+$/u, "");
export const HEADLESS = process.env.E2E_HEADED !== "1";

/** 先按常规解析；找不到再试用户给的全局 node_modules。这两步都是显式的。 */
async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch (error) {
    const dir = process.env.E2E_PLAYWRIGHT_DIR;
    if (!dir) {
      throw new Error(`解析不到 playwright（${error.message}）。装一个，或设 E2E_PLAYWRIGHT_DIR 指向装它的 node_modules。`);
    }
    return import(new URL("playwright/index.mjs", `file:///${dir.replace(/\\/gu, "/").replace(/\/?$/u, "/")}`).href);
  }
}

export const { chromium } = await loadPlaywright();

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export const log = (ok, name, extra = "") =>
  console.log(`${ok ? "✔" : "✘"} ${name}${extra ? ` — ${extra}` : ""}`);

export async function until(fn, { timeout = 20000, every = 250, what = "条件" } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(every);
  }
  throw new Error(`等待超时：${what}${last === undefined ? "" : `（最后一次读到 ${JSON.stringify(last)}）`}`);
}

/** 从页面里读一份"我现在看到了什么"——诊断信息比断言本身更重要。 */
export const observe = page => page.evaluate(async () => {
  const { S } = await import("/js/state.mjs");
  const snap = S.snaps[S.snaps.length - 1] || null;
  const text = id => (document.getElementById(id) || {}).textContent || "";
  return {
    screen: S.screen,
    connected: S.connected,
    meId: S.meId,
    tenant: S.tenant,
    connText: text("connText"),
    title: text("roomTitle"),
    botCount: text("botCount"),
    roster: document.querySelectorAll("#rosterRows .roster-chip").length,
    cards: document.querySelectorAll("#roomList .room-card").length,
    mapSeed: S.map ? S.map.seed : null,
    names: S.room ? S.room.members.map(m => m.n) : [],
    roomId: S.room ? S.room.id : null,
    // 举手与开局闸门在界面上的投影：房主的开打按钮亮不亮、我自己的举手状态。
    allReady: S.room ? S.room.allReady : null,
    startEnabled: !document.getElementById("startButton").disabled,
    readyOn: document.getElementById("readyButton").classList.contains("on"),
    // 选边：`myTeam` 是我自己选的那一边，`sides` 是名册上每个人的边（-1 = 自动）。
    myTeam: S.room && S.room.you ? S.room.you.team : null,
    sides: S.room ? S.room.members.map(m => m.tm) : [],
    roleNote: text("rosterNote"),
    self: S.mine ? { x: S.mine.x, y: S.mine.y, tm: S.mine.tm, hp: S.mine.hp, al: S.mine.al, h: S.mine.h } : null,
    actors: snap ? snap.a.map(a => ({ ow: a.ow, k: a.k, tm: a.tm, al: a.al })) : [],
    bullets: snap ? snap.b.length : 0,
    score: snap ? snap.sc : null,
    ticks: snap ? snap.tk : 0,
    feed: document.getElementById("killFeed").textContent.replace(/\s+/gu, " ").slice(0, 160),
    healthText: text("healthText"),
  };
});

/**
 * 开一个客户端。`seed:false` 时**不预先写名字**——那是留给"起名弹窗"这条路径的：
 * 名字必须先被问过一次、写进 localStorage，之后才谈得上进房。
 */
export async function openClient(browser, nick, { seed = true } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", error => console.log(`  [${nick}] 页面报错：${error.message}`));
  page.on("console", msg => { if (msg.type() === "error") console.log(`  [${nick}] console：${msg.text()}`); });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  if (seed) {
    await page.fill("#nickInput", nick);
    await page.dispatchEvent("#nickInput", "change");
  }
  await until(async () => (await observe(page)).connText.includes("已连接"), { what: `${nick} 拿到会话` });
  return page;
}

/** 真人输入走真实事件，而不是直接改 `S`——否则测的就不是"输入上行"这条链路了。 */
export async function holdKey(page, code, ms) {
  await page.evaluate(c => document.dispatchEvent(new KeyboardEvent("keydown", { code: c })), code);
  await sleep(ms);
  await page.evaluate(c => document.dispatchEvent(new KeyboardEvent("keyup", { code: c })), code);
}
