/**
 * 本地联调的**场景**：几个浏览器各自扮演一个真人，走完"开房 → 拉人 → 放机器人 →
 * 举手 → 开打 → 进场 → 移动 → 邀请链接补位 → 对射"的全流程。
 *
 * 为什么要有这个脚本：单元测试只能证明"内核算得对"，房间名册和 WebSocket 串联
 * 起来对不对，只有真开浏览器才知道。它跑在**已启动的** `wrangler dev` 之上，
 * 自己不起服务，也不碰线上账号——所以它不会产生任何账单。
 *
 * 用法：
 *   node tools/e2e-local.mjs            # 默认打 http://127.0.0.1:8790
 *   E2E_BASE=http://127.0.0.1:8788 node tools/e2e-local.mjs
 *   E2E_HEADED=1 node tools/e2e-local.mjs      # 想看着它打，就把窗口开出来
 *
 * 起浏览器、读页面状态、等条件的那些机械动作在 `tools/e2e-harness.mjs` ——
 * 这个文件只关心"测什么"。
 */

import { chromium, HEADLESS, BASE, sleep, until, observe, openClient, holdKey, log } from "./e2e-harness.mjs";

async function main() {
  const browser = await chromium.launch({ channel: "chrome", headless: HEADLESS });
  const steps = [];
  try {
    // ---------------------------------------------------------------- 1. 房间浏览器
    const host = await openClient(browser, "柠檬叔");
    // 访客故意不预置名字：他要走一遍"点进房间 → 被问名字 → 落库"的真实路径。
    const guest = await openClient(browser, "测试员", { seed: false });
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
    // 起名弹窗：第一次进房必须先留个名字，否则一屋子人都叫"游客"。
    const asked = await until(async () => !(await guest.locator("#nameBackdrop").isHidden()),
      { what: "起名弹窗", timeout: 8000, every: 150 }).then(() => true).catch(() => false);
    await guest.fill("#nameInput", "测试员");
    await guest.click("#nameConfirm");
    const RENAME = { what: "两人同在候场，且房间视图已经推到两边" };
    const bothStaged = await until(async () => {
      const [a, b] = [await observe(host), await observe(guest)];
      const ready = x => x.screen === "staging" && x.title === "霓虹中枢 E2E";
      return ready(a) && ready(b) ? [a, b] : null;
    }, RENAME);
    steps.push(["第二个真人能从列表加入房间", true, `房间「${bothStaged[1].title}」`]);
    steps.push(["第一次进房先弹窗起名，名字落进 localStorage 并写进名册",
      asked && bothStaged[1].names.includes("测试员"), `名册：${bothStaged[1].names.join("、")}`]);

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

    // ---------------------------------------------------------------- 3.2 选边
    // 分队模式里，真人自己选边——"想跟朋友一队"只有这一条路。界面上要看得见这个流程，
    // 服务端才会认；所以这里从**点按钮**开始测，而不是直接改 S。
    //
    // 访客选**红队**、房主保持「自动」：自动分配是"往人少的那边补"，所以两人会各占
    // 一边——这正是第 6 步"看得见人类对手"成立的前提。（要是两人都选蓝队，他们就
    // 该是队友，那是这一版刻意允许的，但不是这条断言要验的东西。）
    await guest.click('#teamPicker [data-team="1"]');
    const sided = await until(async () => {
      const [a, b] = [await observe(host), await observe(guest)];
      const index = a.names.indexOf("测试员");
      return index >= 0 && a.sides[index] === 1 && b.myTeam === 1 ? [a, b] : null;
    }, { what: "访客选边同步到房主" }).catch(() => null);
    steps.push(["访客自己选红队，房主的名册上也显示红队", !!sided,
      sided ? `名册侧别 ${JSON.stringify(sided[0].sides)}` : "没等到选边生效"]);

    // ---------------------------------------------------------------- 3.5 举手与开局闸门
    // 访客没举手之前，房主的开打按钮必须是灰的——"等大家举手"这句提示也就成立了。
    const gated = await until(async () => {
      const a = await observe(host);
      return a.allReady === false && a.startEnabled === false ? a : null;
    }, { what: "房主的开打按钮被举手闸门按住" }).catch(() => null);
    steps.push(["有人没举手时，房主的开打按钮是灰的", !!gated,
      gated ? `名册 ${gated.names.join("、")}` : "没等到闸门生效"]);

    await guest.click("#readyButton");
    const unlocked = await until(async () => {
      const [a, b] = [await observe(host), await observe(guest)];
      return a.allReady === true && a.startEnabled === true && b.readyOn === true ? [a, b] : null;
    }, { what: "举手之后房主的开打按钮亮起来" }).catch(() => null);
    steps.push(["访客举手之后，房主可以开打（两边状态一致）", !!unlocked,
      unlocked ? "allReady=true / start 可点 / 我这边显示已举手" : "没等到解锁"]);

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

    // ---------------------------------------------------------------- 5. 移动：本地预测 + 服务端对账
    // **跟着"进场"紧接着跑**：这时候双方都是刚出生的满血状态。放到后面去测，
    // 一旦角色被机器人打死（3v3 里几秒钟的事），"按 W 走不动"就变成了在验尸体。
    const before = (await observe(host)).self;
    await holdKey(host, "KeyW", 700);
    await sleep(900);
    const after = (await observe(host)).self;
    const moved = Math.hypot(after.x - before.x, after.y - before.y);
    steps.push(["按 W 之后，服务端认得我移动了", moved > 12 && after.al === 1,
      `位移 ${moved.toFixed(1)}px（权威坐标，不是本机预测）`]);

    // ---------------------------------------------------------------- 5.5 邀请链接
    // "拉人"必须一条链接就够：拿到链接的人直接进门，不用先在列表里翻房间号。
    // 这里刻意挑**对局中**测——那是最难的一种：他要现补一个实体进场。
    const roomId = (await observe(host)).roomId;
    const invite = await host.evaluate(async id => (await import("/js/invite.mjs")).inviteLink(id), roomId);
    const lateContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const late = await lateContext.newPage();
    await late.goto(invite, { waitUntil: "domcontentloaded" });
    const askedLate = await until(async () => !(await late.locator("#nameBackdrop").isHidden()),
      { what: "拿到链接的人被问名字", timeout: 8000, every: 150 }).then(() => true).catch(() => false);
    await late.fill("#nameInput", "链接来客");
    await late.click("#nameConfirm");
    const linked = await until(async () => {
      const [a, b] = [await observe(host), await observe(late)];
      return b.roomId === roomId && b.screen === "play" && b.self && a.names.includes("链接来客")
        ? [a, b] : null;
    }, { what: "拿到链接的人补位进场", timeout: 20000 }).catch(() => null);
    steps.push(["邀请链接直接把人送进同一间房，并在对局中补位",
      !!linked && askedLate && invite.includes(`room=${roomId}`),
      linked ? `${invite.replace(BASE, "")} · 名册 ${linked[0].names.join("、")}` : "没等到进场"]);
    await lateContext.close();

    // ---------------------------------------------------------------- 6. 混战名册
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
