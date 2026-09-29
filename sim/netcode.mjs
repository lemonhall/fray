/**
 * 输入命令队列：**服务端那一半**输入时间线。
 *
 * 为什么需要"命令"这个概念：只发"我现在按着哪个方向"的话，服务端只能按墙上时间
 * 一帧一帧地套用最新意图，于是"客户端走了多久"和"服务端走了多久"没有对应关系——
 * 一旦消息断流、世界补算超预算，服务端会**丢掉一段时间**，而本机预测走的是真实
 * 时间，两边差出几百像素，客户端只能把玩家硬拽回去（就是那句"人往前走了一段，
 * 又跳回一小段"）。
 *
 * 现在的协议把时间还给客户端：每 40ms 发一条命令 = "这段时间我按着这个方向，
 * 走了 n 格（一格 = 1/60 秒）"。服务端每 tick 从队头消耗一格，走完一条就把它的
 * 序号记为 ack，连同**走完那一刻的坐标**回给客户端。客户端从那个坐标出发，把
 * 还没被确认的命令重放一遍，就得到"我自己此刻应该在哪"。
 *
 * 三条不变式（改动这里之前先读一遍）：
 *   1. 一条命令只有一个方向——方向变了就必须换新命令，否则重放会走形；
 *   2. ack 单调递增，且 ack 位置是"命令走完那一刻"的坐标，不是"现在的坐标"；
 *   3. 服务端每 tick 最多消耗一格，永远不因为消息来得快就多走——移速上限靠这个守。
 */

/** 单条命令最多声明几格。250ms 的浏览器卡顿也吃得下，再多就是客户端在吹牛。 */
export const MAX_CMD_TICKS = 20;

/** 队列总预算（格）。超了就丢**队头**（最老的输入），等于给"真实时间"封顶。 */
export const MAX_QUEUED_TICKS = 150;

/** 建号 / 重生 / 重连 / 掉线：输入时间线都从零开始，ack 位置就是当前坐标。 */
export function resetQueue(a) {
  a.cmds = [];
  a.queued = 0;
  a.ack = 0;
  a.ackX = a.x;
  a.ackY = a.y;
  a.pendingAck = 0;
  a.lastCmdAt = 0;
}

/**
 * 收到一条上行命令。`n` 已经由调用方夹到 [0, MAX_CMD_TICKS]；`n === 0` 的命令
 * 不入队（它只是"世界别停"的心跳，客户端也没把它计入待确认列表）。
 */
export function pushCmd(a, cmd, now) {
  a.lastCmdAt = now;
  if (cmd.n <= 0) return;
  a.cmds.push(cmd);
  a.queued += cmd.n;
  while (a.queued > MAX_QUEUED_TICKS && a.cmds.length > 1) {
    const dropped = a.cmds.shift();
    a.queued -= dropped.n;
    // 丢掉的这一段不会再被走：ack 直接跳到它，位置就取"现在"。
    a.ack = dropped.sq;
    a.ackX = a.x;
    a.ackY = a.y;
  }
}

/**
 * 本 tick 该用哪条命令——从队头拿一格。动作位只在命令的第一格触发一次，
 * 否则按住的那 3 格会把闪避触发 3 次。
 */
export function takeCmd(a) {
  const head = a.cmds[0];
  if (!head) return null;
  const act = head.act | 0;
  head.act = 0;
  head.n--;
  a.queued--;
  if (head.n <= 0) {
    a.cmds.shift();
    // 位置要等这一格真的走完才记，所以先挂起，由 settleAck 收尾。
    a.pendingAck = head.sq;
  }
  return { mx: head.mx, my: head.my, a: head.a, f: head.f, act, r: head.r };
}

/** 一格走完之后收尾：把"命令完成时的坐标"记成权威确认点。 */
export function settleAck(a) {
  if (!a.pendingAck) return;
  a.ack = a.pendingAck;
  a.ackX = a.x;
  a.ackY = a.y;
  a.pendingAck = 0;
}

/** 队列里还剩几格——诊断用（延迟越高，队列越深，代表"预测领先了多少"）。 */
export const queuedTicks = a => a.queued | 0;
