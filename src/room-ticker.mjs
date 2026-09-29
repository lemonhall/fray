/**
 * 对局的节拍器：**房间的时钟**。
 *
 * 它只干一件事——按住 50ms 的网格，在每一拍把世界推进到"网格上该到的时刻"，然后喊一声
 * 回调让房间去广播。它不碰 WebSocket、不碰存储，所以可以在 Node 里直接测（见
 * `tests/room-ticker.test.mjs`）。
 *
 * 为什么需要它：旧实现里世界是**被消息到达驱动**的（有人上行才补算、够 50ms 才广播）。
 * 25Hz 的上行碰上 50ms 的广播窗口，两个节奏互不整除，于是相邻两张快照的世界时间时而是
 * 50ms、时而是 100ms，世界的平均速度还比墙上时钟快一截（线上实测约 1.2 倍）。客户端的
 * 插值头按真实时间匀速走，面对这种输入只能一会儿冻住、一会儿猛追——用户看到的就是
 * **"机器人像幻灯片"**。
 *
 * 两条硬规矩：
 *   1. 世界的时刻取**网格上该到的时刻**（`target`），不取计时器实际醒来的时刻。workerd
 *      的 `setTimeout(50)` 实测平均 62ms 才醒，按实际时刻推进世界就比广播快 1.2 倍。
 *   2. 醒得太晚（DO 被冻了一下）就**只丢快照、不丢世界时间**——否则世界会比墙上时钟
 *      永久落后一截，那又是另一种幻灯片。
 */

import { MAX_CATCHUP_TICKS } from "../sim/constants.mjs";
import { advanceWorld, beatGrid } from "./room-match.mjs";
import { BROADCAST_MS } from "./room-consts.mjs";

export class MatchTicker {
  constructor({ onFrame, onEnd, log = null }) {
    this.onFrame = onFrame;
    this.onEnd = onEnd;
    this.log = log;
    this.world = null;
    this.nextBcastMs = 0;
    this.lastTickMs = 0;
    this.timer = null;
  }

  /** 开局：把网格原点定在现在，并排出第一拍。 */
  start(world, now = Date.now()) {
    this.stop();
    this.world = world;
    this.lastTickMs = now;
    this.nextBcastMs = now + BROADCAST_MS;
    this.schedule();
    return now;
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.world = null;
  }

  /**
   * 立刻推进到 `now` 并广播一帧，随后把网格原点挪到 `now`。开局用它推第一帧：
   * 客户端要先在自己的快照里找到"我"这个实体才会开始上行输入，少了这一帧两边会
   * 互相等，直到 alarm 兜底才动起来。
   */
  flush(world, now = Date.now()) {
    this.lastTickMs = advanceWorld(world, this.lastTickMs, now, MAX_CATCHUP_TICKS);
    if (world.phase !== "live") return false;
    this.onFrame(now);
    this.nextBcastMs = now + BROADCAST_MS;
    return true;
  }

  /**
   * 踩一拍。没到网格上的点就什么都不做（所以消息驱动、计时器驱动、alarm 驱动都可以
   * 随便调它，谁先来都无所谓）。世界不在进行中返回 `false` 并停表。
   */
  beat(now = Date.now()) {
    const world = this.world;
    if (!world) return false;
    // 世界已经结束了（比如在别处结算过）：停表，并让房间去做收尾。`finish()` 自己是
    // 幂等的，所以"谁来报告结束"不重要，重要的是别漏。
    if (world.phase !== "live") return this.end();
    const grid = beatGrid({ now, nextBcastMs: this.nextBcastMs, broadcastMs: BROADCAST_MS });
    if (grid) {
      if (this.log && grid.skipped > 2) {
        this.log({ t: "beat-late", late: now - this.nextBcastMs, skipped: grid.skipped });
      }
      this.nextBcastMs = grid.next;
      this.lastTickMs = advanceWorld(world, this.lastTickMs, grid.target, MAX_CATCHUP_TICKS);
      if (world.phase !== "live") return this.end();
      this.onFrame(now);
    }
    this.schedule();
    return true;
  }

  /** 把计时链条接回来（输入到达时顺手调一次：定时器被节流了也不至于整段停摆）。 */
  keepAlive() {
    if (this.world && this.world.phase === "live") this.schedule();
  }

  end() {
    this.stop();
    this.onEnd();
    return false;
  }

  schedule() {
    if (this.timer) return;
    // 睡到"网格上的下一拍"为止，而不是死睡 50ms：计时器每拍晚 12ms 才醒，
    // 这里就少睡 12ms 补回来，偏差因此永远不会累积。
    const wait = Math.max(0, Math.min(BROADCAST_MS, this.nextBcastMs - Date.now()));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.beat();
    }, wait);
  }
}
