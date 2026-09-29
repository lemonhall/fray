/**
 * Lobby：一个租户一个实例，持有这个租户的房间目录。
 *
 * 为什么目录要单点：房间列表天然要求"强一致的一览"。如果每个房间各自往 KV 里塞
 * 自己的状态，列表页就会看到重复、幽灵房间和过期人数。交给一个 DO 记，问题消失。
 */

import { DurableObject } from "cloudflare:workers";

const STALE_MS = 90_000;
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export class Lobby extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.rooms = new Map();
    ctx.blockConcurrencyWhile(async () => {
      const saved = (await ctx.storage.get("rooms")) || {};
      this.rooms = new Map(Object.entries(saved));
    });
  }

  async update(info) {
    if (!info || !info.id) return;
    this.rooms.set(info.id, { ...info, updatedAt: Date.now() });
    await this.persist();
  }

  async remove(roomId) {
    this.rooms.delete(roomId);
    await this.persist();
  }

  async list() {
    const now = Date.now();
    let pruned = false;
    for (const [id, room] of this.rooms) {
      if (now - room.updatedAt > STALE_MS) { this.rooms.delete(id); pruned = true; }
    }
    if (pruned) await this.persist();
    return [...this.rooms.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** 建房：先占目录，再让 Room 自己初始化（幂等）。 */
  async create(config, maxRooms) {
    if (this.rooms.size >= maxRooms) return { ok: false, error: "too_many_rooms" };
    let roomId = "";
    for (let i = 0; i < 6; i++) {
      roomId = makeCode();
      if (!this.rooms.has(roomId)) break;
    }
    const stub = this.env.ROOM.getByName(`${config.tenant}:${roomId}`);
    const info = await stub.init({ ...config, roomId });
    this.rooms.set(roomId, { ...info, updatedAt: Date.now() });
    await this.persist();
    return { ok: true, roomId, room: info };
  }

  /** 快速匹配：挑一个还在 staging 且没满的房间，没有就新建。 */
  async quickMatch(config, maxRooms) {
    const rooms = await this.list();
    const open = rooms.find(r => r.phase === "staging" && r.humans < r.capacity && r.mode === config.mode);
    if (open) return { ok: true, roomId: open.id, reused: true };
    return this.create(config, maxRooms);
  }

  async persist() {
    await this.ctx.storage.put("rooms", Object.fromEntries(this.rooms));
  }
}

function makeCode() {
  const buf = new Uint8Array(6);
  crypto.getRandomValues(buf);
  return [...buf].map(b => ALPHABET[b % ALPHABET.length]).join("");
}
