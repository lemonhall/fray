/**
 * 客户端那一半输入时间线：把"我这几帧按着哪个方向、走了几格"打成一条命令。
 *
 * 一条命令里只有一个方向、只有一段时间——这是服务端能逐格重放的前提。所以方向
 * 一变就顺手把上一条收尾发走，而不等下一个 40ms 的节拍。代价是方向切换时多几条
 * 消息，换来的是"重放出来的路径和本机预测逐像素一致"。
 *
 * 格数（`n`）是这条命令的全部意义：25Hz 上行时它通常是 2~3；浏览器卡一下会是 6~8；
 * 死了或者没在跑，它就是 0——那时这条消息只负责"让世界别停"。
 */

import { S } from "./state.mjs";

export const SEND_MS = 40;

/** 待确认列表的兜底上限：服务端彻底不回 ack 时，别让内存无限涨。 */
const MAX_PENDING = 400;

/** 方向量化到 1/16：摇杆的细微抖动不该把命令切得粉碎。 */
const QUANT = 16;
const quant = v => Math.round(v * QUANT) / QUANT;
const round3 = v => Math.round(v * 1000) / 1000;

let post = () => {};

/** 注入发送函数，避免这一层去 import 网络层（那会绕出一个循环依赖）。 */
export function initCmds(fn) { post = fn; }

export function resetCmds() {
  S.cmds = [];
  S.cmd = null;
  S.cmdSeq = 0;
  S.lastSentAt = 0;
}

/**
 * 本帧要预测的方向（也就是要写进命令的方向）。返回的 `cmd` 由调用方逐格
 * `noteTick`，再定期 `flushCmd` 出去。
 */
export function frameDir(now, dirX, dirY, angle, flags) {
  const mx = quant(dirX), my = quant(dirY);
  const cur = S.cmd;
  if (cur && cur.n > 0 && (cur.mx !== mx || cur.my !== my)) {
    flush(flags);
    S.lastSentAt = now;
  }
  if (!S.cmd) S.cmd = { sq: ++S.cmdSeq, mx, my, a: angle, n: 0 };
  else if (S.cmd.n === 0) { S.cmd.mx = mx; S.cmd.my = my; }
  S.cmd.a = angle;
  return S.cmd;
}

/**
 * 走了一格。**第一格就把这条命令挂进待确认列表**——这一步不能等到 flush：
 * 快照随时可能在两条命令之间落地，对账时是"权威确认点 + 待确认命令重放"，
 * 如果正在走的那条还没进列表，它对账时就会凭空少走几格，画面上就是一次小回退。
 */
export function noteTick(cmd) {
  if (!cmd.tracked) { cmd.tracked = true; S.cmds.push(cmd); }
  cmd.n++;
}

/** 到点就把当前命令收尾发出去。返回是否真的发了。 */
export function flushCmd(now, flags, force = false) {
  if (!S.cmd) return false;
  if (!force && now - S.lastSentAt < SEND_MS) return false;
  if (!flush(flags)) return false;
  S.lastSentAt = now;
  return true;
}

/**
 * 收尾：把命令打成一条上行报文。
 *
 * `act`（一次性动作位）在这里被消费掉——由**最先发生的那个 flush** 带走，所以
 * 一次按键永远只触发一次闪避。`k` 只是给老服务端兜底的位掩码，新协议传的是
 * 量化后的 mx/my 向量（摇杆的模拟量才不会退化成八向）。
 */
function flush(flags) {
  const cmd = S.cmd;
  if (!cmd) return false;
  S.cmd = null;
  const act = S.actions | 0;
  S.actions = 0;
  post({
    t: "in", sq: cmd.sq, mx: cmd.mx, my: cmd.my, n: cmd.n,
    k: flags.k | 0, a: round3(cmd.a), f: flags.f ? 1 : 0, act, r: flags.r | 0,
  });
  if (S.cmds.length > MAX_PENDING) S.cmds.splice(0, S.cmds.length - MAX_PENDING);
  return true;
}
