/**
 * Room：一个房间一个实例。名册、开局、对局推进、快照广播都在这里。
 *
 * 时钟模型（这个项目最重要的一条设计，别改）：
 *   **没有常驻定时器。** 每当任意客户端发来一条消息，就把模拟"补算"到当前墙上时间，
 *   然后在 50ms 的节流窗口里广播一次快照。客户端以 20Hz 持续发输入，于是世界就以
 *   20Hz 的粒度稳定推进。
 *
 * 好处是在 Cloudflare 上不需要长跑定时任务（账单与生命周期都简单），坏处是所有客户端
 * 同时掉线时世界会停——所以有一个 5 秒的 alarm 兜底做清理与回收声明。
 */

import { DurableObject } from "cloudflare:workers";
import { MAX_CATCHUP_TICKS, TICK_HZ } from "../sim/constants.mjs";
import { MAX_CMD_TICKS, pushCmd } from "../sim/netcode.mjs";
import { decodeMove } from "../sim/input.mjs";
import { encodeSnapshot } from "../sim/wire.mjs";
import { applyPerk } from "../sim/actor.mjs";
import { verifyToken } from "./auth.mjs";
import {
  createRoomState, isHost, view as roomView, publicView, startCheck,
} from "./room-state.mjs";
import { beginMatch, resetMatch, actorIdOf, advanceWorld } from "./room-match.mjs";
import { attach, detach, onMessage, broadcastRoom, broadcast, sendTo } from "./room-conns.mjs";
import { ALARM_MS, BROADCAST_MS } from "./room-consts.mjs";
import { recordMatch } from "./results.mjs";

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.conns = new Map();
    this.state = null;
    this.world = null;
    this.mapMsg = null;
    this.lastTickMs = 0;
    this.lastBroadcastMs = 0;
    this.reported = false;
    ctx.blockConcurrencyWhile(async () => {
      this.state = (await ctx.storage.get("room")) || null;
    });
  }

  /** 由 Lobby/Worker 调用：建房间（幂等，重复调用不会重置已有房间）。 */
  async init(config) {
    if (!this.state) {
      this.state = createRoomState(config);
      await this.persist();
    }
    await this.ctx.storage.setAlarm(Date.now() + ALARM_MS);
    return publicView(this.state);
  }

  async info() {
    return this.state ? publicView(this.state) : null;
  }

  /** WebSocket 升级。身份由 Worker 校验后通过内部头传进来，DO 只信任这个头。 */
  async fetch(request) {
    const upgrade = (request.headers.get("upgrade") || "").toLowerCase();
    if (upgrade !== "websocket") return new Response("expected websocket", { status: 426 });
    if (!this.state) return new Response("room not initialised", { status: 409 });
    // 令牌在这里、而不是在 Worker 里验：DO 的名字里已经带了租户，它自己就知道
    // 该跟哪个租户比对；同时请求对象保持原样（一个字节都没被重构），
    // 也就不会踩到"改了 header 之后 WebSocket 升级头丢了"的经典坑。
    const url = new URL(request.url);
    const session = await verifyToken(this.env.SESSION_SECRET, url.searchParams.get("token") || "");
    if (!session || session.tenantId !== this.state.tenant) {
      return new Response("unauthorized", { status: 401 });
    }
    const playerId = session.playerId;
    const playerName = session.name;

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.attach(server, playerId, playerName);
    return new Response(null, { status: 101, webSocket: client });
  }

  // 下面这些是**转发方法**：真正的实现住在 `room-conns.mjs`，这个类只保留
  // Durable Object 该有的形状。房间对外的接口没变，逻辑却按职责分了家。
  attach(ws, playerId, name) { attach(this, ws, playerId, name); }
  detach(ws) { detach(this, ws); }
  onMessage(ws, data) { onMessage(this, ws, data); }
  broadcastRoom() { broadcastRoom(this); }
  broadcast(payload) { broadcast(this, payload); }
  sendTo(ws, payload) { sendTo(ws, payload); }

  start(ws, conn) {
    if (!isHost(this.state, conn.playerId) || this.state.phase === "live") return;
    const check = startCheck(this.state);
    if (!check.ok) return this.sendTo(ws, { t: "error", error: check.error });
    const { world, mapMsg } = beginMatch(this.state);
    this.world = world;
    this.mapMsg = mapMsg;
    this.lastTickMs = Date.now();
    this.lastBroadcastMs = 0;
    this.reported = false;
    this.broadcast({ t: "begin", room: roomView(this.state, null) });
    this.broadcast(mapMsg);
    // 开局立刻推第一帧快照。这一步不能省：客户端要先在自己的快照里找到"我"这个
    // 实体才会开始上行输入（本地预测需要它），而服务端的推进又是被输入驱动的——
    // 少了这一帧，两边会互相等，直到 5 秒后的 alarm 兜底才动起来，表现为"开打后
    // 画面卡住几秒"。顺序也重要：快照必须排在 map 之后，客户端才有地图去解码。
    this.tick(true);
    this.broadcastRoom();
    void this.publish();
    void this.ctx.storage.setAlarm(Date.now() + ALARM_MS);
  }

  reset(ws, conn) {
    if (!isHost(this.state, conn.playerId) || this.state.phase !== "over") return;
    resetMatch(this.state, this.world);
    this.world = null; this.mapMsg = null; this.reported = false;
    this.broadcastRoom();
    void this.persist(); void this.publish();
  }

  perk(conn, msg) {
    if (!this.world || this.world.phase !== "live") return;
    const actor = this.world.actors.find(a => a.ownerId === conn.playerId);
    if (actor) applyPerk(this.world, actor, String(msg.id || ""));
  }

  input(conn, msg) {
    if (!this.world || this.world.phase !== "live") return;
    const actor = this.world.actors.find(a => a.ownerId === conn.playerId);
    if (!actor) return;
    const now = Date.now();
    const dir = Number.isFinite(msg.mx) || Number.isFinite(msg.my)
      ? { x: Number(msg.mx) || 0, y: Number(msg.my) || 0 }
      : decodeMove(msg.k | 0);
    // `n` 是新协议的核心：这条命令代表"几格"（1 格 = 1/60 秒）。
    // 老客户端不带它，就按"距上一条命令的墙上时间"折算成格数——那正是改版前的语义，
    // 所以线上前后端版本错开的那个窗口里，玩家不会莫名走不动或者飞起来。
    const gapMs = actor.lastCmdAt ? now - actor.lastCmdAt : 1000 / TICK_HZ;
    const declared = Number.isFinite(msg.n) ? Math.round(msg.n) : Math.round(gapMs / 1000 * TICK_HZ);
    const n = Math.max(0, Math.min(MAX_CMD_TICKS, declared));
    pushCmd(actor, {
      sq: Math.max(Math.floor(Number(msg.sq) || 0), (actor.ack | 0) + 1),
      mx: dir.x, my: dir.y,
      a: Number.isFinite(msg.a) ? msg.a : actor.angle,
      f: msg.f ? 1 : 0,
      act: (msg.act | 0) & 7,
      r: Number.isFinite(msg.r) ? Math.max(55, Math.min(380, msg.r)) : 310,
      n,
    }, now);
    // 不强制广播：50ms 的节流窗口负责节奏，否则 6 个人各自 25Hz 上行就是
    // 每秒 150 次全员广播，白白把 CPU 和带宽烧掉。
    this.tick(false);
  }

  /** 唯一的推进点。补算到"现在"，然后按节流窗口决定是否广播。 */
  tick(force) {
    const now = Date.now();
    if (!this.world || this.world.phase !== "live") return;
    this.lastTickMs = advanceWorld(this.world, this.lastTickMs, now, MAX_CATCHUP_TICKS);
    if (this.world.phase !== "live") return this.finish();
    if (force || now - this.lastBroadcastMs >= BROADCAST_MS) this.broadcastSnapshot(now);
  }

  broadcastSnapshot(now) {
    this.lastBroadcastMs = now;
    for (const [ws, conn] of this.conns) {
      if (ws.readyState !== 1) continue;
      const selfId = actorIdOf(this.world, conn.playerId);
      this.sendTo(ws, encodeSnapshot(this.world, selfId));
    }
    this.world.events = [];
  }

  finish() {
    if (this.reported) return;
    this.reported = true;
    this.state.phase = "over";
    this.state.results = this.world.results;
    this.state.endedAt = Date.now();
    this.broadcast({ t: "over", results: this.world.results });
    this.broadcastRoom();
    void this.persist();
    void this.publish();
    void this.report();
  }

  async persist() {
    if (this.state) await this.ctx.storage.put("room", this.state);
  }

  /** 房间目录是 Lobby 的职责，Room 只负责把最新状态推过去。 */
  async publish() {
    if (!this.state) return;
    try { await this.env.LOBBY.getByName(this.state.tenant).update(publicView(this.state)); }
    catch { /* 目录是加速项，写失败不该让对局停摆 */ }
  }

  async report() {
    if (!this.state.results) return;
    try {
      await recordMatch(this.env, this.state, this.world);
    } catch { /* 结算入库失败不阻塞房间回收 */ }
  }

  /** 兜底心跳：清理空房、续订目录、必要时回到 staging。 */
  async alarm() {
    const now = Date.now();
    if (this.conns.size === 0) {
      if (this.state) await this.delistDeadRoom();
      return;
    }
    if (this.world && this.world.phase === "live") this.tick(false);
    if (now - (this.state?.updatedAt || 0) > 10 * 60_000) return this.delistDeadRoom();
    await this.ctx.storage.setAlarm(now + ALARM_MS);
  }

  async delistDeadRoom() {
    if (this.state) {
      try { await this.env.LOBBY.getByName(this.state.tenant).remove(this.state.roomId); }
      catch { /* 同 publish */ }
      this.state.phase = "staging";
      this.state.members = [];
      this.world = null;
      await this.persist();
    }
    await this.ctx.storage.deleteAlarm();
  }
}
