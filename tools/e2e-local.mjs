/**
 * 本地双客户端联调：两个浏览器各自扮演一个真人，走完"开房 → 加入 → 放机器人 →
 * 开打 → 进场 → 移动 → 对射"的全流程。
 *
 * 为什么要有这个脚本：单元测试只能证明"内核算得对"，房间名册和 WebSocket 串联
 * 起来对不对，只有真开两个浏览器才知道。它跑在**已启动的** `wrangler dev` 之上，
 * 自己不起服务，也不碰线上账号——所以它不会产生任何账单。
 *
 * 用法：
 *   node tools/e2e-local.mjs            # 默认打 http://127.0.0.1:8790
 *   E2E_BASE=http://127.0.0.1:8788 node tools/e2e-local.mjs
 *   E2E_HEADED=1 node tools/e2e-local.mjs      # 想看着它打，就把窗口开出来
 *
 * 需要 Playwright 与本机 Chrome（用 `channel:"chrome"`，所以**不下载**它自带的那
 * 几百兆浏览器）。Playwright 装在本仓库 (`npm i -D playwright`) 或全局都行：
 * 全局装的话给它指个路 —— `E2E_PLAYWRIGHT_DIR=/path/to/node_modules`。
 */

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

const { chromium } = await loadPlaywright();

const BASE = process.env.E2E_BASE || "http://127.0.0.1:8790";
const HEADLESS = process.env.E2E_HEADED !== "1";
const logs = [];

const log = (ok, name, extra = "") => {
  const line = `${ok ? "✔" : "✘"} ${name}${extra ? ` — ${extra}` : ""}`;
  logs.push(line);
  console.log(line);
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(fn, { timeout = 20000, every = 250, what = "条件" } = {}) {
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
const observe = page => page.evaluate(async () => {
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
    self: S.mine ? { x: S.mine.x, y: S.mine.y, tm: S.mine.tm, hp: S.mine.hp, al: S.mine.al, h: S.mine.h } : null,
    actors: snap ? snap.a.map(a => ({ ow: a.ow, k: a.k, tm: a.tm, al: a.al })) : [],
    bullets: snap ? snap.b.length : 0,
    score: snap ? snap.sc : null,
    ticks: snap ? snap.tk : 0,
    feed: text("killFeed").replace(/\s+/gu, " ").slice(0, 160),
    healthText: text("healthText"),
  };
});

async function openClient(browser, nick) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", error => console.log(`  [${nick}] 页面报错：${error.message}`));
  page.on("console", msg => { if (msg.type() === "error") console.log(`  [${nick}] console：${msg.text()}`); });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.fill("#nickInput", nick);
  await page.dispatchEvent("#nickInput", "change");
  await until(async () => (await observe(page)).connText.includes("已连接"), { what: `${nick} 拿到会话` });
  return page;
}

/** 真人输入走真实事件，而不是直接改 `S`——否则测的就不是"输入上行"这条链路了。 */
async function holdKey(page, code, ms) {
  await page.evaluate(c => document.dispatchEvent(new KeyboardEvent("keydown", { code: c })), code);
  await sleep(ms);
  await page.evaluate(c => document.dispatchEvent(new KeyboardEvent("keyup", { code: c })), code);
}

async function main() {
  const browser = await chromium.launch({ channel: "chrome", headless: HEADLESS });
  const steps = [];
  try {
    // ---------------------------------------------------------------- 1. 房间浏览器
    const host = await openClient(browser, "柠檬叔");
    const guest = await openClient(browser, "测试员");
    const browse = await observe(host);
    steps.push(["进站后看到房间浏览器与租户", browse.screen === "rooms" && browse.tenant === "neon",
      `租户 ${browse.tenant}`]);

    // ---------------------------------------------------------------- 2. 建房 / 列表 / 加入
    await host.click("#openCreateButton");
    await host.fill("#createName", "霓虹中枢 E2E");
    await host.selectOption("#createMode", "control");
    await host.selectOption("#createDifficulty", "1");
    await host.fill("#createBots", "4");
    await host.click("#createRoomButton");
    await until(async () => (await observe(host)).screen === "staging", { what: "房主进入候场" });
    // 访客那边列表是 4 秒一轮的轮询，所以这里先手动刷新一次再点卡片。
    await guest.click("#refreshRooms");
    await until(async () => (await observe(guest)).cards > 0, { what: "访客看到房间卡片" });
    await guest.click("#roomList .room-card");
    const RENAME = { what: "两人同在候场，且房间视图已经推到两边" };
    const bothStaged = await until(async () => {
      const [a, b] = [await observe(host), await observe(guest)];
      const ready = x => x.screen === "staging" && x.title === "霓虹中枢 E2E";
      return ready(a) && ready(b) ? [a, b] : null;
    }, RENAME);
    steps.push(["第二个真人能从列表加入房间", true, `房间「${bothStaged[1].title}」`]);

    // ---------------------------------------------------------------- 3. 房主部署机器人
    await host.click('#botStepper [data-bot="1"]');
    const bots = await until(async () => {
      const [a, b] = [await observe(host), await observe(guest)];
      return a.botCount === "5" && b.botCount === "5" ? [a, b] : null;
    }, { what: "机器人数量同步到两边" });
    steps.push(["房主加机器人，两个客户端同步看到 5 个机器人 + 2 名真人",
      bots[0].roster === 7 && bots[1].roster === 7,
      `名册 ${bots[0].roster} 格 / 机器人 ${bots[0].botCount}`]);

    // 权限投影：访客的加减按钮必须是灰的（真正的拒绝在服务端）。
    const guestDisabled = await guest.evaluate(() =>
      [...document.querySelectorAll("#botStepper button")].every(b => b.disabled));
    steps.push(["非房主看到的是不可点的机器人控件", guestDisabled]);

    // ---------------------------------------------------------------- 4. 开打
    // `begin` 只负责切屏，地图是紧接着单独一条报文——所以要等到 seed 真的到了才算进场。
    const startAt = Date.now();
    await host.click("#startButton");
    const playing = await until(async () => {
      const [a, b] = [await observe(host), await observe(guest)];
      return a.screen === "play" && b.screen === "play" && a.mapSeed && b.mapSeed ? [a, b] : null;
    }, { what: "两边都进入竞技场并收到地图", timeout: 25000 });
    const startMs = Date.now() - startAt;
    steps.push(["房主开打，两个真人同时进场", playing[0].mapSeed === playing[1].mapSeed,
      `同一张地图 seed=${playing[0].mapSeed}`]);
    // 开打之后必须先有第一帧快照，客户端才知道"我"是谁、才能开始上行输入。
    // 少这一帧，两边互等，只能等 5 秒的 alarm 兜底——所以这里卡一个紧的时间上限。
    steps.push(["开打后 2.5 秒内就有第一帧快照（不靠 alarm 兜底）", startMs < 2500, `${startMs}ms`]);

    // ---------------------------------------------------------------- 5. 混战名册
    // 可见性是按视角裁剪出来的，所以"某一瞬间看得见谁"取决于站位与草丛——
    // 这里累计一段时间，断言的是"这段时间里两类实体都出现过"，而不是"第一帧就有"。
    const seen = { humans: 0, bots: 0 };
    await until(async () => {
      const snap = await observe(host);
      for (const a of snap.actors) {
        if (a.ow === snap.meId) continue;
        if (a.k === 1) seen.humans = 1;
        else seen.bots = 1;
      }
      return seen.humans && seen.bots;
    }, { what: "快照里同时出现过真人对手与机器人", timeout: 30000, every: 700 }).catch(() => null);
    steps.push(["我方能看见对面对手与机器人（可见性过滤之后的快照）",
      !!seen.humans && !!seen.bots, `看得见真人 ${seen.humans} 类 / 机器人 ${seen.bots} 类`]);

    // ---------------------------------------------------------------- 6. 移动：本地预测 + 服务端对账
    const before = (await observe(host)).self;
    await holdKey(host, "KeyW", 700);
    await sleep(900);
    const after = (await observe(host)).self;
    const moved = Math.hypot(after.x - before.x, after.y - before.y);
    steps.push(["按 W 之后，服务端认得我移动了", moved > 12 && after.al === 1,
      `位移 ${moved.toFixed(1)}px（权威坐标，不是本机预测）`]);

    // ---------------------------------------------------------------- 7. 开火：对方能看见我的子弹
    await host.mouse.move(720, 450);
    await host.mouse.down();
    const sawBullet = await until(async () => {
      const [a, b] = [await observe(host), await observe(guest)];
      return (a.bullets > 0 && b.bullets > 0) ? { a, b } : null;
    }, { what: "两个客户端都收到子弹", timeout: 12000, every: 120 }).catch(() => null);
    await host.mouse.up();
    steps.push(["开火产生子弹，并且对端快照里也能看到",
      !!sawBullet, sawBullet ? `我方 ${sawBullet.a.bullets} 发 / 对端 ${sawBullet.b.bullets} 发` : "12 秒内没观察到子弹"]);

    // ---------------------------------------------------------------- 8. 世界真的在推进
    const ticking = await until(async () => {
      const a = await observe(host);
      return a.ticks > 0 && a.self ? a : null;
    }, { what: "对局 tick 前进" });
    const tickSample = await until(async () => {
      const a = await observe(host);
      return a.ticks > ticking.ticks ? a : null;
    }, { what: "第二次采样 tick 继续前进", timeout: 8000 });
    steps.push(["权威世界持续推进（服务端 tick 单调递增）",
      tickSample.ticks > ticking.ticks, `tick ${ticking.ticks} → ${tickSample.ticks}`]);

    // ---------------------------------------------------------------- 9. 混战：机器人互相开火
    const fighting = await until(async () => {
      const [a, b] = [await observe(host), await observe(guest)];
      const hit = [a, b].find(x => x.feed.length > 0);
      return hit || null;
    }, { what: "击杀播报出现（人机混战开打）", timeout: 70000, every: 700 }).catch(() => null);
    log(!!fighting, "全场混战有战果（机器人之间也会互相淘汰）", fighting ? fighting.feed : "70 秒内没有播报");
    return steps;
  } finally {
    await browser.close();
  }
}

const steps = await main();
console.log("\n—— 联调结果 ——");
for (const [name, ok, extra] of steps) console.log(`${ok ? "✔" : "✘"} ${name}${extra ? ` — ${extra}` : ""}`);
const failed = steps.filter(([, ok]) => !ok);
console.log(`\n${steps.length - failed.length} / ${steps.length} 项通过`);
process.exit(failed.length ? 1 : 0);
