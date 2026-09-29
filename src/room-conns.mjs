/**
 * Room 的**连接面**：谁连上了、收到什么消息、往谁回。
 *
 * 每个函数都以 `room` 实例为第一参数。拆出来的理由很实际：一个房间同时有
 * "连接管理"和"对局生命周期"两件事，塞在一个类里会一路顶到 300 行以上，
 * 读的人得在两件事之间来回跳。类那边保留同名的**一行转发方法**，
 * 所以 Durable Object 的对外形状（`attach` / `detach` / `onMessage` / `broadcast`）
 * 一个都没变，`index.mjs` 和测试都不用改。
 */

import {
  addMember, removeMember, isHost, setBots, setConfig, setMemberGadget,
  setReady, setTeam, kickMember, view as roomView,
} from "./room-state.mjs";
import { joinLive, dropPlayer, ejectFromWorld } from "./room-match.mjs";
import { ALARM_MS, MAX_MSGS_PER_SEC } from "./room-consts.mjs";
import { resetQueue } from "../sim/netcode.mjs";

/** 连上了：入名册、回一帧 hello；如果对局已经开着，直接把他投进场上补位。 */
export function attach(room, ws, playerId, name) {
  // 每个连接一份消息预算。原来的漏桶挂在房间上，等于 6 个人共享 70 条/秒——
  // 6 个人各 25Hz 上行就是 150 条/秒，全员都在被自己的房间限流，输入成片地丢。
  const conn = { playerId, name, budgetAt: 0, budgetN: 0 };
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
  // 重连回来用的是**同一个角色**，但输入时间线必须是新的：旧连接攒下的命令属于
  // 上一个浏览器会话，留着会让角色在重连瞬间自己往前走一段。
  const actor = room.world && room.world.phase === "live"
    ? room.world.actors.find(a => a.ownerId === playerId)
    : null;
  if (actor) resetQueue(actor);
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
  if (!rateOk(conn)) return;
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
    // 举手 / 取消举手。房主的"开打"按钮就是他的表态，所以服务端会拒掉房主的 ready。
    case "ready":
      setReady(room.state, conn.playerId, !!msg.v);
      void room.persist();
      return broadcastRoom(room);
    case "team": {
      const ok = setTeam(room.state, conn.playerId, msg.tm === undefined ? null : msg.tm);
      if (!ok) return sendTo(ws, { t: "error", error: "team_rejected" });
      void room.persist();
      return broadcastRoom(room);
    }
    case "kick": return kick(room, ws, conn, msg);
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

/**
 * 踢人：只有房主能踢、不能踢自己、踢了要**当场把人请出连接**。
 *
 * 顺序是有讲究的：先从名册里摘掉（服务端权威立刻生效），再关连接。反过来做的话，
 * 关闭事件会先跑一遍 `detach`，那一遍仍然会走"正常离开"的路径——名册上是干净了，
 * 但"被踢"这件事就没人知道了，玩家只会看到"连接断开"。
 */
function kick(room, ws, conn, msg) {
  if (!isHost(room.state, conn.playerId)) return;
  const target = String(msg.id || "");
  if (!target || target === conn.playerId) {
    return sendTo(ws, { t: "error", error: "kick_self" });
  }
  if (!kickMember(room.state, target)) return sendTo(ws, { t: "error", error: "kick_missing" });
  ejectFromWorld(room.world, target);
  for (const [peer, other] of room.conns) {
    if (other.playerId !== target) continue;
    sendTo(peer, { t: "kicked" });
    try { peer.close(1008, "kicked"); } catch { /* 已经关了 */ }
    room.conns.delete(peer);
  }
  broadcastRoom(room);
  void room.persist();
  void room.publish();
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
export function rateOk(conn, now = Date.now()) {
  if (now - conn.budgetAt > 1000) { conn.budgetAt = now; conn.budgetN = 0; }
  conn.budgetN++;
  return conn.budgetN <= MAX_MSGS_PER_SEC;
}
