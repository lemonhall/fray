/**
 * 本地预测：只预测**我自己**的位移。
 *
 * 为什么可以这么小：`applyMove` 是纯函数，只依赖网格、箱子和移速，不碰随机源，
 * 所以浏览器和服务端算出同一个结果。子弹、伤害、死亡一概不预测——那些必须听
 * 权威端的，否则就会出现"我这边打死了、别人那边还活着"。
 *
 * 对账（reconcile）是这个文件里唯一需要小心的地方，它的做法是**时间线对齐**：
 * 服务端在快照里回一个"第几条命令已经走完、那时你在哪"，我从那个坐标出发，把
 * 还没被确认的命令重放一遍。正常情况下这次算出来的位置和本机预测**逐像素相同**，
 * 于是画面上什么都不会发生——不再有"走一段被拽回一小段"。
 * 详细推导见 `sim/replay.mjs`。
 */

// 这两个 import 刻意写成**相对路径**而不是站点绝对的 `/sim/...`（浏览器里两者等价，
// 因为 web/sim 就是 sim 的构建副本）。这样 `tests/` 里的 Node 测试可以直接 import
// 这个文件，把"预测 + 对账"这条最容易出错的路当成普通模块来跑——
// 手感问题只有能被自动化地量出来，才算真的修好了。
import { applyMove } from "../sim/input.mjs";
import { replayFrom } from "../sim/replay.mjs";
import { resetCmds } from "./cmd.mjs";

/**
 * 重放结果与本机位置差距大到这个量级，说明是传送/复活这种"整体挪动"，直接认账；
 * 否则一律平滑收敛——哪怕差 200px 也是滑过去，不是"啪"地跳过去。
 */
const RUNAWAY = 420;
const BLEND = .22;
/**
 * 小于这个量级的差异**不是分歧，是浮点**。两端跑的是同一个 `applyMove`，但方向被
 * 量化成 1/16、每格位移又乘 dt，最后一位小数的舍入差会让"重放"比"本机预测"差出
 * 0.0x 像素。这点误差如果也走平滑，就会被乘成反方向的抖动，眼睛看到的就是"帧在
 * 往回走"。所以它直接认账——位置取重放结果，画面一动不动。
 */
const EPS = .5;
/** 老服务端（快照里没有 ak/ax/ay）才启用的老规矩：差距太大就硬吸附。 */
const LEGACY_SNAP_AT = 70;

export function initPredict(S, map, meSnapshot) {
  resetCmds();
  S.predictW = {
    mode: map.mode, grid: map.grid, walls: map.walls, bushes: map.bushes, boxes: map.boxes,
    seed: map.seed, time: 0, tick: 0, phase: "live", difficulty: 0,
    actors: [], bullets: [], cubes: [], grenades: [], fields: [], supplies: [], scheduled: [], events: [],
    zone: { x: 0, y: 0, r: 0 }, ring: { x: 0, y: 0, r: 9999 }, score: [0, 0], nextEntity: 1,
  };
  S.predictMe = {
    id: -1, kind: "human", type: meSnapshot.h, ownerId: "",
    x: meSnapshot.x, y: meSnapshot.y, r: 21, angle: meSnapshot.an,
    vx: 0, vy: 0, walk: 0, perks: {}, overdrive: 0, dash: 0, alive: true,
  };
  S.predictW.actors = [S.predictMe];
}

export function stepPredict(S, dt, dirX, dirY, angle) {
  if (!S.predictW) return null;
  const me = S.predictMe;
  me.angle = angle;
  applyMove(S.predictW, me, dirX, dirY, dt);
  return me;
}

/**
 * 权威快照回来了：把"服务端确认过的那个点"接上"还没被确认的命令"，重放一遍。
 *
 * 只做三件事：
 *   1. 同步那些会和移速有关的状态（天赋、生死）——预测必须和权威端用同一套参数，
 *      否则重放出来的路径天生就对不上；
 *   2. 丢掉已经被 ack 覆盖的命令，然后从 ack 坐标重放剩下的；
 *   3. 正常情况（误差≈0）什么都不改；真出现分歧时平滑收敛，不对玩家"啪"一下。
 */
export function reconcile(S, snapshotMe) {
  const me = S.predictMe;
  if (!me || !snapshotMe) return;
  me.type = snapshotMe.h;
  // 移速受"迅捷"天赋影响，而预测用的是 me.perks；不同步就等于两边跑不同的速度。
  if (snapshotMe.pk) me.perks = { ...snapshotMe.pk };
  me.alive = !!snapshotMe.al;
  if (!snapshotMe.al) {
    S.cmds.length = 0;
    me.x = snapshotMe.x; me.y = snapshotMe.y; me.angle = snapshotMe.an;
    return;
  }
  if (!Number.isFinite(snapshotMe.ak) || !Number.isFinite(snapshotMe.ax)) return legacy(S, snapshotMe, me);

  const ack = snapshotMe.ak | 0;
  const pending = S.cmds.filter(cmd => cmd.sq > ack);
  if (pending.length !== S.cmds.length) S.cmds = pending;

  const fromX = me.x, fromY = me.y;
  replayFrom(S.predictW, me, S.cmds, snapshotMe.ax, snapshotMe.ay);
  const err = Math.hypot(me.x - fromX, me.y - fromY);
  if (err > EPS && err <= RUNAWAY) {
    me.x = fromX + (me.x - fromX) * BLEND;
    me.y = fromY + (me.y - fromY) * BLEND;
  }
}

/**
 * 老服务端（快照里没有确认点）的退路：只能拿"现在的权威坐标"和本机预测比，
 * 差距大就硬吸附、小就慢慢拉——也就是改版前那套办法。留着它只为版本错开的
 * 那个窗口，线上前后端稳定在同一个版本之后它不会再被走到。
 */
function legacy(S, snapshotMe, me) {
  const dx = snapshotMe.x - me.x, dy = snapshotMe.y - me.y;
  if (Math.hypot(dx, dy) > LEGACY_SNAP_AT) { me.x = snapshotMe.x; me.y = snapshotMe.y; return; }
  me.x += dx * BLEND;
  me.y += dy * BLEND;
}

/** 箱子被打碎之后就不再挡路，所以预测用的障碍物必须跟着权威端更新。 */
export function applyBoxUpdates(map, rows) {
  for (const [id, hp, alive] of rows) {
    const box = map.boxes.find(b => b.id === id);
    if (!box) continue;
    box.hp = hp;
    box.alive = !!alive;
  }
}
