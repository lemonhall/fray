/**
 * Room 的三个时间/频率常量。
 *
 * 单独放一个文件，是因为 `room.mjs`（对局生命周期）与 `room-conns.mjs`（连接面）
 * 各需要其中一个；谁都不该去 import 另一个的私有常量，那会把两件事重新粘起来。
 */

/** 广播节流窗口：任何上行消息都会推进世界，但最多 20Hz 往外发快照。 */
export const BROADCAST_MS = 50;

/** 单连接每秒最多接受多少条上行消息，超了整条丢掉（不做排队，也不踢人）。 */
export const MAX_MSGS_PER_SEC = 70;

/** alarm 兜底间隔：清空房、续房间目录，以及"输入流断了也别让世界停死"。 */
export const ALARM_MS = 5000;
