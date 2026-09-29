/**
 * 渲染视图：把快照缓冲插值成"这一刻应该画成什么样"。
 *
 * 两个时间点很关键：
 *   - `serverTime` 是权威时钟（快照带过来的）；
 *   - 渲染时间比它**晚 90ms**（扣掉一帧的延迟），于是任何两个快照之间都恰好有
 *     一个包可以插值，画面就不会一跳一跳。
 * 这 90ms 就是拿"操作手感"换"画面平滑"的那笔交易，写在这里是为了以后想改
 * 只有一个地方要改。
 */

import { clamp, lerp } from "/sim/constants.mjs";
import { decodeBullet, decodeCube, decodeGrenade, decodeField, decodeSupply } from "/sim/wire.mjs";

/**
 * 渲染要比最新快照**晚这么多秒**——这是"抖动余量"。
 *
 * 它不是装饰性参数：服务端 20Hz 发快照，但真实链路上相邻两帧的间隔会在几十到
 * 一百多毫秒之间浮动（TCP 排队、DO 唤醒时刻、消息到达的抖动都会叠加进来）。
 * 余量必须盖得住**最长的那个间隔**，否则渲染头一跑到数据前面就只能冻住等下一帧，
 * 来得那一刻又猛跳一段——这正是"机器人像幻灯片"的观感来源。
 * 0.09 对 20Hz 的均匀快照刚好够，对真实链路就太紧了；给到 0.14 覆盖到 140ms 的
 * 间隔，代价是画面比权威端晚 140ms（对俯视射击是可接受的量级）。
 */
export const INTERP_DELAY = .14;

export function pushSnapshot(S, snap) {
  S.snaps.push(snap);
  if (S.snaps.length > 16) S.snaps.shift();
  S.serverTime = snap.tm;
  S.wall = snap.wt || Math.round((S.snaps.length > 1 ? S.wall + (snap.tm - S.lastTm) * 1000 : snap.tm * 1000));
  S.lastTm = snap.tm;
  if (snap.ph === "over") S.screen = "over";
}

export const latest = S => S.snaps[S.snaps.length - 1] || null;

function brackets(S, tm) {
  const snaps = S.snaps;
  if (snaps.length === 0) return null;
  if (snaps.length === 1) return [snaps[0], snaps[0], 0];
  for (let i = snaps.length - 1; i >= 1; i--) {
    if (snaps[i - 1].tm <= tm) {
      const span = (snaps[i].tm - snaps[i - 1].tm) || .05;
      return [snaps[i - 1], snaps[i], clamp((tm - snaps[i - 1].tm) / span, 0, 1)];
    }
  }
  return [snaps[0], snaps[0], 0];
}

const lerpAngle = (a, b, t) => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
};

/** 按 id 在前后两帧里找同一条实体，插值它的位置，其余字段以新帧为准。 */
function blend(older, newer, t, keyOf) {
  const map = new Map(older.map(e => [keyOf(e), e]));
  return newer.map(entity => {
    const prev = map.get(keyOf(entity));
    if (!prev) return entity;
    return { ...entity, x: lerp(prev.x, entity.x, t), y: lerp(prev.y, entity.y, t) };
  });
}

export function buildView(S) {
  const snap = latest(S);
  if (!snap || !S.map) return null;
  const tm = renderHead(S, snap);
  const [older, newer, t] = brackets(S, tm);
  const meId = S.meId;

  const actors = blend(older.a, newer.a, t, ify("i")).map(a => {
    const prev = older.a.find(p => p.i === a.i);
    return { ...a, angle: prev ? lerpAngle(prev.an, a.an, t) : a.an };
  });
  const mine = actors.find(a => a.ow && a.ow === S.meId) || null;
  if (mine) S.actorId = mine.i;
  if (mine && S.predictMe) {
    mine.x = S.predictMe.x;
    mine.y = S.predictMe.y;
    mine.angle = S.predictMe.angle;
  }
  if (mine) {
    S.me = mine;
    S.meTeam = mine.tm;
  }

  const bullets = blend(older.b.map(decodeBullet), newer.b.map(decodeBullet), t, ify("id"));
  const boxes = S.map.boxes.filter(b => b.alive);

  return {
    time: tm,
    mode: S.map.mode,
    tick: newer.tk,
    actors,
    player: mine || null,
    bullets,
    boxes,
    cubes: blend(older.cb.map(decodeCube), newer.cb.map(decodeCube), t, ify("id")),
    grenades: newer.gr.map(decodeGrenade),
    fields: newer.fd.map(decodeField),
    supplies: newer.sp.map(decodeSupply),
    zone: newer.z,
    ring: newer.rg,
    score: newer.sc,
    phase: newer.ph,
  };
}

const ify = key => value => value[key];

/**
 * 这一刻该渲染**世界时间轴上的哪一点**——整套平滑的关键就在这里。
 *
 * 判据只有一条：**头离"理想位置"有多远**。理想位置 = 最新一帧的世界时间再往回退
 * `INTERP_DELAY`（140ms），也就是"抖动余量刚好用满"的那一点。规矩是：
 *
 *   - 偏差在 15ms 以内 → **严格 1.0 倍速**。世界本身也是 1.0 倍速（服务端按 50ms 的
 *     固定网格推进，探针实测"总世界时间 / 总墙上时间 = 1.001"），匀速就是跟得上；
 *   - 落后（正偏差）→ 最多提到 1.25 倍速，几秒钟把位置挣回来；
 *   - 超前（负偏差，缓冲快用完了）→ 最多降到 0.5 倍速。减速比加速狠，因为"撞上数据
 *     边缘"是唯一会直接变成卡顿的情况。
 *   - 落后超过 250ms（服务端停了一小会儿，或者刚从后台切回来）→ 不爬了，直接归位。
 *     慢慢爬的那一两秒画面会明显"快放"，比一次跳变更难接受。
 *
 * 为什么旧版会走成"走一帧、停几帧"：它拿"落后就 1.6 倍猛追、超前就按住不让走"当
 * 控制器。追赶只在落后时生效，等于把噪声整流成了单方向的加速度，均衡点必然滑到
 * "按住"那一侧；而"按住"本身又让头永远贴着数据边缘回不来。探针量到的头部推进
 * 变异系数是 **1.47**。现在这个控制器有对称的反馈：超前就减速、落后就加速，均衡点
 * 稳定在理想位置，剩下的抖动量级是 **0.03~0.07**（±5% 以内），肉眼看不见。
 *
 * 唯一允许"冻住"的地方是最后那道闸：头真的跑到最新一帧前面去了（连续丢包），
 * 除了等没有别的选择。`INTERP_DELAY` 就是留给它的余量。
 *
 * 这些数字不是拍的：`tools/pacing-probe.mjs` 会把真实快照序列喂进这套算法，
 * 逐帧重算"屏幕上每个实体挪了多少像素"，并输出头部推进量的变异系数。
 */
function renderHead(S, snap) {
  const now = performance.now();
  const dt = Math.min((now - (S.headAt || now)) / 1000, .25);
  let tm = S.headTm ?? snap.tm - INTERP_DELAY;
  // 正数 = 头落后于理想位置（离最新一帧更远），需要追。
  const err = snap.tm - INTERP_DELAY - tm;
  // 掉队半秒以上（切标签页、被系统冻结）就别慢慢爬了，直接对齐——那种情况下
  // 玩家已经"断了"，一次跳变比慢动作几秒钟更好。
  if (err > .25) tm = snap.tm - INTERP_DELAY;
  else tm += dt * rateFor(err);
  // 头绝不能跑到最新一帧前面：那里没有数据，硬走只能靠外推，而外推的方向一错
  // 就是一次"拽回"。留 20ms 余量，让插值永远落在两个真实快照之间。
  const limit = snap.tm - .02;
  if (tm > limit) tm = limit;
  S.headTm = tm; S.headAt = now;
  return tm;
}

/** 15ms 死区内严格 1.0 倍速；之后线性修正：追最多 +25%，退最多 −50%。 */
function rateFor(err) {
  const mag = Math.abs(err);
  if (mag < .015) return 1;
  const over = Math.min(mag - .015, .2);
  const cap = err > 0 ? .25 : .5;
  return 1 + Math.sign(err) * Math.min(cap, over * (err > 0 ? 1.2 : 2.5));
}
