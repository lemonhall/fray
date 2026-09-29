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
    await this.prune();
    return [...this.rooms.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** 把过期条目清掉。列表、建房都会先跑一遍——目录是配额的一部分，不能只在读的时候才想起来打扫。 */
  async prune() {
    const now = Date.now();
    let pruned = false;
    for (const [id, room] of this.rooms) {
      if (now - room.updatedAt > STALE_MS) { this.rooms.delete(id); pruned = true; }
    }
    if (pruned) await this.persist();
  }

  /**
   * 建房：先占目录，再让 Room 自己初始化（幂等）。
   *
   * 建房前的这次 `prune()` 很关键：配额是按目录条数算的，如果只让 `list()` 打扫，
   * 一条都不 list 的租户会被一堆早就没人了的房间占满 `maxRooms`，然后**再也开不出
   * 新房**——而且看列表还是空的，说不清是哪儿出了问题。
   */
  async create(config, maxRooms) {
    await this.prune();
    if (this.rooms.size >= maxRooms) return { ok: false, error: "too_many_rooms" };
    const roomId = this.freeCode();
    // 撞不出来就干脆认输。原来的写法撞满 6 次会**拿着那个已经被人占着的码往下走**，
    // 把别人房间的目录条目覆盖掉——概率低不代表可以对，这里不留这个坑。
    if (!roomId) return { ok: false, error: "no_room_code" };
    const stub = this.env.ROOM.getByName(`${config.tenant}:${roomId}`);
    const info = await stub.init({ ...config, roomId });
    this.rooms.set(roomId, { ...info, updatedAt: Date.now() });
    await this.persist();
    return { ok: true, roomId, room: info };
  }

  /** 找一个还没被占用的房号。试满一轮还全撞上（现实中意味着目录已经满了）就返回空。 */
  freeCode() {
    for (let i = 0; i < ALPHABET.length; i++) {
      const code = makeCode();
      if (!this.rooms.has(code)) return code;
    }
    return "";
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
