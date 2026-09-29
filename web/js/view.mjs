/**
 * 渲染视图：把快照缓冲插值成"这一刻应该画成什么样"。
 *
 * 两个时间点很关键：
 *   - `serverTime` 是权威时钟（快照带过来的）；
 *   - 渲染时间比它**晚 90ms**（扣掉一帧的延迟），于是任何两个快照之间都恰好有
 *     一个包可以插值，画面就不会一跳一跳。
 * 这 90ms 就是拿"操作手感"换"画面平滑"的那笔交易，写在这里是为了以后想改
 * 只有一个地方要改。
 */

import { clamp, lerp } from "/sim/constants.mjs";
import { decodeBullet, decodeCube, decodeGrenade, decodeField, decodeSupply } from "/sim/wire.mjs";

export const INTERP_DELAY = .09;

export function pushSnapshot(S, snap) {
  S.snaps.push(snap);
  if (S.snaps.length > 16) S.snaps.shift();
  S.serverTime = snap.tm;
  if (snap.ph === "over") S.screen = "over";
}

export const latest = S => S.snaps[S.snaps.length - 1] || null;

function brackets(S, tm) {
  const snaps = S.snaps;
  if (snaps.length === 0) return null;
  if (snaps.length === 1) return [snaps[0], snaps[0], 0];
  for (let i = snaps.length - 1; i >= 1; i--) {
    if (snaps[i - 1].tm <= tm) {
      const span = (snaps[i].tm - snaps[i - 1].tm) || .05;
      return [snaps[i - 1], snaps[i], clamp((tm - snaps[i - 1].tm) / span, 0, 1)];
    }
  }
  return [snaps[0], snaps[0], 0];
}

const lerpAngle = (a, b, t) => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
};

/** 按 id 在前后两帧里找同一条实体，插值它的位置，其余字段以新帧为准。 */
function blend(older, newer, t, keyOf) {
  const map = new Map(older.map(e => [keyOf(e), e]));
  return newer.map(entity => {
    const prev = map.get(keyOf(entity));
    if (!prev) return entity;
    return { ...entity, x: lerp(prev.x, entity.x, t), y: lerp(prev.y, entity.y, t) };
  });
}

export function buildView(S) {
  const snap = latest(S);
  if (!snap || !S.map) return null;
  const tm = snap.tm - INTERP_DELAY;
  const [older, newer, t] = brackets(S, tm);
  const meId = S.meId;

  const actors = blend(older.a, newer.a, t, ify("i")).map(a => {
    const prev = older.a.find(p => p.i === a.i);
    return { ...a, angle: prev ? lerpAngle(prev.an, a.an, t) : a.an };
  });
  const mine = actors.find(a => a.ow && a.ow === S.meId) || null;
  if (mine) S.actorId = mine.i;
  if (mine && S.predictMe) {
    mine.x = S.predictMe.x;
    mine.y = S.predictMe.y;
    mine.angle = S.predictMe.angle;
  }
  if (mine) {
    S.me = mine;
    S.meTeam = mine.tm;
  }

  const bullets = blend(older.b.map(decodeBullet), newer.b.map(decodeBullet), t, ify("id"));
  const boxes = S.map.boxes.filter(b => b.alive);

  return {
    time: tm,
    mode: S.map.mode,
    tick: newer.tk,
    actors,
    player: mine || null,
    bullets,
    boxes,
    cubes: blend(older.cb.map(decodeCube), newer.cb.map(decodeCube), t, ify("id")),
    grenades: newer.gr.map(decodeGrenade),
    fields: newer.fd.map(decodeField),
    supplies: newer.sp.map(decodeSupply),
    zone: newer.z,
    ring: newer.rg,
    score: newer.sc,
    phase: newer.ph,
  };
}

const ify = key => value => value[key];
