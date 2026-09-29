/**
 * 客户端唯一的可变状态。所有模块读它、写它，不再各自维护副本。
 *
 * 刻意不做成 class：这份状态里没有一条不变式需要靠封装来守，
 * 而"一个对象、打开 DevTools 就能看到全貌"对调试的价值远大于形式的整齐。
 */

export const S = {
  screen: "rooms",              // rooms | staging | play | over
  me: null,                     // 我自己的角色（来自最新快照）
  mine: null,                   // 最新快照里我自己的原始（未插值）实体
  meId: "",
  meTeam: 0,
  hero: 0,
  playerName: "玩家",
  token: "",
  tenant: "",
  room: null,                   // 房间视图：名册 / 房主 / 阶段
  isHost: false,
  mode: "control",
  map: null,                    // 解码后的地图：网格 / 墙 / 草丛 / 箱子
  seed: 0,
  snaps: [],                    // 快照环形缓冲，渲染与插值都从这里取
  serverTime: 0,
  wall: 0,                      // 最新快照的**墙上时间**（毫秒）；插值的唯一时钟
  lastTm: 0,
  headTm: 0,                    // 渲染头此刻所在的世界时间（秒），逐帧匀速推进
  headAt: 0,
  results: null,
  connected: false,

  view: { w: 0, h: 0, zoom: 1 },
  dpr: 1,
  cam: { x: 0, y: 0 },
  shake: 0,
  rtt: 0,
  hitUntil: 0,                  // 命中准星的高亮截止时刻（performance.now）
  ground: null,                 // 本局地面离屏画布，开局只画一次
  assist: false,                // 辅助开火（本地行为，不上行）

  keys: new Set(),
  mouse: { x: 0, y: 0, down: false, known: false },
  touch: { move: { x: 0, y: 0 }, aim: { x: 0, y: 0, active: false } },
  actions: 0,                   // 待发出的一次性动作位：1 闪避 2 装置 4 大招
  seq: 0,
  lastSentAt: 0,
  lastPingAt: 0,

  predictW: null,               // 本地预测用的迷你世界（地形 + 我自己）
  cmd: null,                    // 正在累积的这一条输入命令（方向 + 已走的格数）
  cmds: [],                     // 已经发出去、还没被服务端 ack 的命令（重放用）
  cmdSeq: 0,
};

/** 纯表现层状态：粒子、跳字、扩散环、光束、击杀播报。 */
export const FX = { particles: [], floaters: [], rings: [], beams: [], feed: [] };
