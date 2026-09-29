/**
 * 一次性（但可重复执行）的文案/骨架改写工具。
 *
 * web/index.html 是从桌面那份单机版 HTML 里**逐字节抽取**出来的（见
 * `extract-original.mjs`），CSS 与矢量精灵原样保留。这个脚本做三件事：
 *   1. 把原版的名字与页脚文案换成 FRAY 自己的；
 *   2. 挂上「房间浏览器」这一屏的 DOM 骨架（原版没有这一屏）；
 *   3. 在大厅里挂上「候场名册 / 房主控制」的 DOM 骨架。
 *
 * 它刻意写成**幂等**的：每条替换只在源串还在时才动手，已经改过的直接跳过，
 * 所以跑两遍不会把页面改坏。若某条 from/to 都找不到，说明 index.html 被改飘了，
 * 脚本会报错退出——宁可炸，也不要静默产出半拉页面。
 */

import { readFileSync, writeFileSync } from "node:fs";

const HTML = new URL("../web/index.html", import.meta.url);
const source = readFileSync(HTML, "utf8");

const LOBBY_OPEN = '<section id="lobby" aria-label="游戏大厅">';

const ROOM_BANNER = `
<div class="room-banner" id="roomBanner">
<span class="phase-badge" id="roomPhase">准备中</span>
<strong id="roomTitle">房间</strong>
<span class="room-code" id="roomCodeLabel">#------</span>
<span class="room-meta" id="roomMeta">热点争夺 · 0 人 + 0 机器人</span>
<button class="text-button" id="leaveRoomButton">离开房间 <span>↗</span></button>
</div>
<aside class="roster-panel" id="rosterPanel" aria-label="参战名册">
<div class="roster-top"><span>参战名册 <b>ROSTER</b></span><span class="panel-counter" id="rosterCount">1 / 6</span></div>
<div class="roster-rows" id="rosterRows"></div>
<div class="roster-controls">
<div class="bot-stepper" id="botStepper" title="只有房主能调整">
<span>机器人 <b>BOT</b></span>
<button type="button" data-bot="-1" aria-label="减少机器人">−</button>
<b id="botCount">4</b>
<button type="button" data-bot="1" aria-label="增加机器人">+</button>
</div>
<span class="roster-note" id="rosterNote">等待房主开始…</span>
</div>
</aside>`;

const ROOMS_SCREEN = `
<section id="rooms" aria-label="房间浏览器">
<div class="rooms-bg"></div>
<header class="rooms-head">
<div class="rooms-brand"><span class="brand-mark">F<span>↗</span></span><div>FRAY<small>霓虹前线 / SERVER AUTHORITATIVE</small></div></div>
<div class="rooms-id">
<label class="nick-field"><span>昵称</span><input id="nickInput" maxlength="16" autocomplete="off" spellcheck="false" placeholder="柠檬叔"></label>
<span class="conn-pill" id="connPill"><i></i><b id="connText">连接中…</b></span>
<button class="icon-button sound-toggle" title="音效开关" aria-label="音效开关"><svg><use href="#i-sound"/></svg></button>
</div>
</header>
<div class="rooms-layout">
<div class="rooms-main">
<div class="rooms-bar">
<div><div class="section-label">房间列表 <span>ROOM BROWSER</span></div><h2 id="roomsHeadline">选一个战场，或者自己开一桌</h2></div>
<div class="rooms-bar-actions">
<button id="refreshRooms" class="icon-button" title="刷新列表" aria-label="刷新列表">⟳</button>
<button id="quickMatchButton" class="secondary-button">快速匹配</button>
<button id="openCreateButton" class="primary-button">创建房间 <span>↗</span></button>
</div>
</div>
<div id="createPanel" class="create-panel hidden">
<label><span>房间名</span><input id="createName" maxlength="24" placeholder="我的战场" autocomplete="off"></label>
<label><span>模式</span><select id="createMode"><option value="control">热点争夺 · 3V3</option><option value="survival">荒野生存 · 混战</option></select></label>
<label><span>机器人难度</span><select id="createDifficulty"><option value="0">轻松</option><option value="1" selected>标准</option><option value="2">老兵</option></select></label>
<label><span>机器人数量</span><input id="createBots" type="number" min="0" max="9" value="4"></label>
<button id="createRoomButton" class="primary-button">建立房间</button>
<button id="cancelCreate" class="text-button">取消</button>
<p class="create-hint" id="createHint">机器人负责补位，一个人也能开打；真人进来会占掉机器人名额。</p>
</div>
<div class="room-list" id="roomList"></div>
<p class="rooms-note" id="roomsNote">房间列表每 4 秒自动刷新。</p>
</div>
<aside class="rooms-side">
<div class="side-panel"><div class="side-panel-head">排行榜 <span>LEADERBOARD</span></div><div id="boardRows" class="side-rows"></div></div>
<div class="side-panel"><div class="side-panel-head">最近战绩 <span>RECENT</span></div><div id="matchRows" class="side-rows"></div></div>
<div class="side-panel"><div class="side-panel-head">怎么玩 <span>STEPS</span></div><ol class="side-steps"><li>输个昵称，进房间或点快速匹配。</li><li>房主按「+」投放机器人、调难度。</li><li>房主开打，人和机器人同场竞技。</li></ol></div>
</aside>
</div>
</section>`;

/**
 * 每条替换写成 { from, to, marker }：
 *   - `marker` 是新内容里唯一的一小段，用来判断"这条到底改过没有"。
 *   - 插入型替换的 `to` 里仍然包含 `from`（比如把房间屏插在 `<main id="app">` 后面），
 *     所以幂等判断必须靠 marker，不能靠"from 是否还在"。
 */
const EDITS = [
  // 1. 品牌：原版叫荒野激斗，这里换成我们自己的名字。
  {
    from: '<a class="brand" href="#" aria-label="荒野激斗首页"><span class="brand-mark">W<span>↗</span></span><span>WILD RUSH<small>荒野激斗 / NEON CIRCUIT</small></span></a><div class="build-pill"><i></i> 2.0 <span>新玩法，已就绪</span></div>',
    to: '<a class="brand" href="#" aria-label="FRAY 首页"><span class="brand-mark">F<span>↗</span></span><span>FRAY<small>霓虹前线 / SERVER AUTHORITATIVE</small></span></a><div class="build-pill"><i></i> 1.0 <span>在线人机混战，已就绪</span></div>',
    marker: 'aria-label="FRAY 首页"',
  },
  {
    from: '<span class="brand-mark">W<span>↗</span></span><div id="mapHeading">',
    to: '<span class="brand-mark">F<span>↗</span></span><div id="mapHeading">',
    marker: '<span class="brand-mark">F<span>↗</span></span><div id="mapHeading">',
  },
  {
    from: '<footer class="lobby-footer"><span>原创角色 / 非官方单机作品</span><span class="footer-mid"><i></i> 无需登录 · 无外部资源 · 浏览器即玩</span><span>LOCAL BUILD <b>2.0</b></span></footer>',
    to: '<footer class="lobby-footer"><span>服务端权威 · 人机同场</span><span class="footer-mid"><i></i> Worker + Durable Objects · 一个账号多个租户</span><span>ONLINE BUILD <b>1.0</b></span></footer>',
    marker: "ONLINE BUILD",
  },
  // 2. 大厅里的两处措辞：难度与开打说明都变成了"房间配置"。
  {
    from: '<div class="section-label">机器人难度 <span>离线对战</span></div>',
    to: '<div class="section-label">机器人难度 <span>房主设置</span></div>',
    marker: '机器人难度 <span>房主设置</span>',
  },
  {
    from: "<small>本地对战 · 即刻开始</small>",
    to: "<small>服务端对战 · 人机混战</small>",
    marker: "服务端对战 · 人机混战",
  },
  // 3. 大厅现在只作为"房间内候场页"，标题与无障碍标签跟着改。
  {
    from: '<section id="lobby" aria-label="游戏大厅">',
    to: '<section id="lobby" aria-label="房间候场">' + ROOM_BANNER,
    marker: 'id="roomBanner"',
  },
  // 顺手消掉浏览器那条"favicon 404"噪音：内联一个空图标就够了，
  // 不值得为一个像素去多一次请求。
  {
    from: "<title>FRAY · 霓虹前线</title>",
    to: '<title>FRAY · 霓虹前线</title>\n<link rel="icon" href="data:,">',
    marker: 'rel="icon"',
  },
  // 4. 房间浏览器整屏，插在 main 的最前面。
  { from: "<main id=\"app\">", to: '<main id="app">' + ROOMS_SCREEN, marker: 'id="rooms"' },
];

let out = source;
const missed = [];
for (const { from, to, marker } of EDITS) {
  if (out.includes(marker)) continue;
  if (!out.includes(from)) { missed.push(from.slice(0, 60)); continue; }
  out = out.split(from).join(to);
}
if (missed.length) {
  console.error("以下替换目标在 index.html 里找不到，请检查 index.html 是否被手工改过：");
  for (const m of missed) console.error("  " + m);
  process.exit(1);
}

if (!out.includes(LOBBY_OPEN) && !out.includes('aria-label="房间候场"')) {
  console.error("大厅开场标签既不是原版也不是改写版，拒绝继续");
  process.exit(1);
}

writeFileSync(HTML, out, "utf8");
console.log(`index.html 已更新：${out.length} 字节`);
