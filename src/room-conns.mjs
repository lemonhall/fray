/**
 * Room 的**连接面**：谁连上了、收到什么消息、往谁回。
 *
 * 每个函数都以 `room` 实例为第一参数。拆出来的理由很实际：一个房间同时有
 * "连接管理"和"对局生命周期"两件事，塞在一个类里会一路顶到 300 行以上，
 * 读的人得在两件事之间来回跳。类那边保留同名的**一行转发方法**，
 * 所以 Durable Object 的对外形状（`attach` / `detach` / `onMessage` / `broadcast`）
 * 一个都没变，`index.mjs` 和测试都不用改。
 */

import { addMember, removeMember, isHost, setBots, setConfig, setMemberGadget, view as roomView } from "./room-state.mjs";
import { joinLive, dropPlayer } from "./room-match.mjs";
import { ALARM_MS, MAX_MSGS_PER_SEC } from "./room-consts.mjs";

/** 连上了：入名册、回一帧 hello；如果对局已经开着，直接把他投进场上补位。 */
export function attach(room, ws, playerId, name) {
  const conn = { playerId, name };
  room.conns.set(ws, conn);
  ws.addEventListener("message", ev => onMessage(room, ws, ev.data));
  ws.addEventListener("close", () => detach(room, ws));
  ws.addEventListener("error", () => detach(room, ws));

  const joined = addMember(room.state, { playerId, name, hero: 0 });
  if (!joined.ok) {
    ws.send(JSON.stringify({ t: "error", error: joined.error }));
    try { ws.close(1008, joined.error); } catch { /* 已经关了 */ }
    room.conns.delete(ws);
    return;
  }
  ws.send(JSON.stringify({ t: "hello", you: { id: playerId, name }, room: roomView(room.state, playerId) }));
  if (room.world && room.world.phase === "live") {
    joinLive(room.world, joined.member);
    ws.send(JSON.stringify(room.mapMsg));
  }
  broadcastRoom(room);
  void room.persist();
  void room.publish();
  void room.ctx.storage.setAlarm(Date.now() + ALARM_MS);
}

/** 断线：名册里删掉，但场上那个角色**留着**——重连进来能接着用同一个实体。 */
export function detach(room, ws) {
  const conn = room.conns.get(ws);
  if (!conn) return;
  room.conns.delete(ws);
  const samePlayerOnline = [...room.conns.values()].some(c => c.playerId === conn.playerId);
  if (samePlayerOnline) return;
  removeMember(room.state, conn.playerId);
  dropPlayer(room.world, conn.playerId);
  broadcastRoom(room);
  void room.persist();
  void room.publish();
}

/** 上行消息的唯一入口。房主专属的那几条（bots / config / start / reset）在这里挡掉。 */
export function onMessage(room, ws, data) {
  const conn = room.conns.get(ws);
  if (!conn) return;
  if (!rateOk(room)) return;
  let msg;
  try { msg = JSON.parse(String(data)); } catch { return; }
  if (!msg || typeof msg.t !== "string") return;

  switch (msg.t) {
    // 心跳也顺手推一格世界：25Hz 的输入是主驱动，但那条流一旦断了（切标签页、
    // 输入还没开始上行），心跳就是"世界别停"的第二道保险。
    case "ping": room.tick(false); return sendTo(ws, { t: "pong", id: msg.id, now: Date.now() });
    case "hero": {
      const m = room.state.members.find(x => x.playerId === conn.playerId);
      if (m && Number.isFinite(msg.i)) m.hero = Math.max(0, Math.min(3, Math.floor(msg.i)));
      return broadcastRoom(room);
    }
    case "gadget":
      setMemberGadget(room.state, conn.playerId, msg.id);
      return broadcastRoom(room);
    case "bots":
      if (!isHost(room.state, conn.playerId)) return;
      setBots(room.state, msg.n);
      void room.persist(); void room.publish();
      return broadcastRoom(room);
    case "config":
      if (!isHost(room.state, conn.playerId)) return;
      setConfig(room.state, msg);
      void room.persist(); void room.publish();
      return broadcastRoom(room);
    case "start": return room.start(ws, conn);
    case "reset": return room.reset(ws, conn);
    case "perk": return room.perk(conn, msg);
    case "in": return room.input(conn, msg);
    default: return;
  }
}

/** 名册/阶段有任何变化就广播一次：房主和普通玩家收到的是同一份数据。 */
export function broadcastRoom(room) {
  for (const [ws, conn] of room.conns) sendTo(ws, roomView(room.state, conn.playerId));
}

export function broadcast(room, payload) {
  const text = JSON.stringify(payload);
  for (const [ws] of room.conns) if (ws.readyState === 1) ws.send(text);
}

export function sendTo(ws, payload) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(payload));
}

/** 一秒内的漏桶：超预算的消息整条丢掉，避免单个客户端把房间的 CPU 吃干。 */
export function rateOk(room) {
  const now = Date.now();
  if (now - room.msgBudget.at > 1000) room.msgBudget = { at: now, n: 0 };
  room.msgBudget.n++;
  return room.msgBudget.n <= MAX_MSGS_PER_SEC;
}
