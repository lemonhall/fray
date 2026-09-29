/**
 * 节奏探针的"尺子"：把录下来的快照序列重算成**玩家眼睛里看到的那个数**。
 *
 * 这里只有纯函数，没有网络、没有定时器，所以既能被 `pacing-probe.mjs`（Node 采集）
 * 用，也能被浏览器 dump 出来的轨迹用——量的是同一把尺子下的同一个数。
 *
 * 关键约束：`brackets()` 与 `rateFor()` 必须与 `web/js/view.mjs` **逐字一致**。
 * 一旦前端的插值规则改了而这里没改，探针量出来的就不再是玩家看到的东西了。
 */

/** 客户端的插值延迟，必须和 `web/js/view.mjs` 里的 `INTERP_DELAY` 一致。 */
export const INTERP_DELAY = .14;

/** 插值规则：和 `web/js/view.mjs` 的 `brackets()` 一致，只是这里在 Node 里重放。 */
export function brackets(snaps, tm) {
  if (snaps.length === 0) return null;
  if (snaps.length === 1) return [snaps[0], snaps[0], 0];
  for (let i = snaps.length - 1; i >= 1; i--) {
    if (snaps[i - 1].tm <= tm) {
      const span = (snaps[i].tm - snaps[i - 1].tm) || .05;
      return [snaps[i - 1], snaps[i], Math.max(0, Math.min(1, (tm - snaps[i - 1].tm) / span))];
    }
  }
  return [snaps[0], snaps[0], 0];
}

/** 和 `web/js/view.mjs` 的 `rateFor()` 逐字一致：带死区的对称控制器。 */
export function rateFor(err) {
  const mag = Math.abs(err);
  if (mag < .015) return 1;
  const over = Math.min(mag - .015, .2);
  const cap = err > 0 ? .25 : .5;
  return 1 + Math.sign(err) * Math.min(cap, over * (err > 0 ? 1.2 : 2.5));
}

export const percentile = (arr, p) => {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
};
export const round = (v, n = 1) => Number(v.toFixed(n));

/**
 * 把录下来的快照按 60Hz 重放一遍，逐帧算"每个实体挪了多少像素"。
 *
 * 理想情况下这个数应当几乎恒定（速度 × 1/60 秒）。如果它一会是 0、一会是好几像素，
 * 那就是幻灯片——而且这正是用户眼睛看到的东西，不是某个中间量。
 */
export function replay(snaps, entityIds, { debug = false } = {}) {
  const perEntity = new Map(entityIds.map(id => [id, []]));
  const dt = 1000 / 60;
  const perFrameDelta = [], headGap = [], headStep = [];
  const headStepClean = [];
  let qi = 0, head = null, headAt = snaps[0].at;
  let prev = new Map(), frames = 0, frozen = 0, bigSteps = 0, edgeHold = 0, jumps = 0;
  for (let t = snaps[0].at; t <= snaps[snaps.length - 1].at; t += dt) {
    while (qi < snaps.length && snaps[qi].at <= t) qi++;
    if (qi === 0) continue;
    const q = snaps.slice(0, qi).slice(-16);
    const newest = q[q.length - 1];
    // 这一段**逐字照抄**客户端 `view.mjs` 的 `renderHead()`——探针的价值全在于此：
    // 量的是玩家真正看到的那个数，而不是我对它的一种近似。
    const target = newest.tm - INTERP_DELAY;
    if (head === null) { head = target; headAt = t; continue; }
    const frameDt = Math.min((t - headAt) / 1000, .25);
    headAt = t;
    const err = newest.tm - INTERP_DELAY - head;
    const snapped = err > .25;
    let next = snapped ? target : head + frameDt * rateFor(err);
    const limit = newest.tm - .02;
    if (next > limit) next = limit;
    // 被"数据边缘"（最新一帧的世界时间）按住的帧数：这是唯一真正会冻住画面的情况。
    if (next >= limit - .0005) edgeHold++;
    if (next - head > .025) jumps++;
    const step = next - head;
    if (next < limit - .0005 && !snapped) headStepClean.push(step);
    head = next;
    const br = brackets(q, head);
    if (!br) break;
    const [older, newer, k] = br;
    if (debug && frames > 20 && frames < 26) {
      console.log(`f=${frames} head=${head.toFixed(3)} older.tm=${older.tm} newer.tm=${newer.tm} k=${k.toFixed(3)} ` +
        `a0=(${older.a[0].x},${older.a[0].y}) b0=(${newer.a[0].x},${newer.a[0].y})`);
    }
    let moved = 0;
    for (const id of entityIds) {
      const a = older.a.find(e => e.i === id), b = newer.a.find(e => e.i === id);
      if (!a || !b) continue;
      const x = a.x + (b.x - a.x) * k, y = a.y + (b.y - a.y) * k;
      const p = prev.get(id);
      if (p) { const d = Math.hypot(x - p[0], y - p[1]); perEntity.get(id).push(d); moved += d; }
      prev.set(id, [x, y]);
    }
    perFrameDelta.push(moved);
    // 头部离最新快照的世界时间有多远：正常的插值窗口应当稳定在 ~90ms。
    headGap.push((newest.tm - head) * 1000);
    headStep.push(step);
    if (moved < .05) frozen++;
    if (moved > 12) bigSteps++;
    frames++;
  }
  return { perEntity, perFrameDelta, headGap, headStep, headStepClean, frames, frozen, bigSteps, edgeHold, jumps };
}

/** 渲染头每帧推进量的统计：理想是恒定 1/60 秒。变异系数小 = 匀速 = 不幻灯片。 */
export function headStepStats(steps) {
  if (steps.length < 2) return { frames: steps.length, cv: null, stalledFrames: 0 };
  const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
  const variance = steps.reduce((s, v) => s + (v - mean) ** 2, 0) / steps.length;
  return {
    frames: steps.length,
    mean: round(mean * 1000, 2),
    cv: mean > 0 ? round(Math.sqrt(variance) / mean, 3) : null,
    stalledFrames: steps.filter(v => v * 1000 < 8).length,
  };
}

/** 用"该实体自己每帧位移的中位数"当基准，量速度的波动——这才是眼睛看到的抖。 */
export function jitterOf(values) {
  const clean = values.filter(v => Number.isFinite(v));
  if (clean.length < 20) return null;
  const med = percentile(clean, .5);
  if (med <= .01) return { median: round(med, 2), p95: round(percentile(clean, .95), 2), ratio: null };
  const ratio = percentile(clean, .95) / med;
  return { median: round(med, 2), p95: round(percentile(clean, .95), 2), ratio: round(ratio, 2) };
}

/** 相邻两帧之间的三条序列：到达间隔、世界推进、逻辑拍号差。 */
export function gaps(rows) {
  const arrival = [], world = [], tk = [];
  for (let i = 1; i < rows.length; i++) {
    arrival.push(rows[i].at - rows[i - 1].at);
    world.push((rows[i].tm - rows[i - 1].tm) * 1000);
    tk.push(rows[i].tk - rows[i - 1].tk);
  }
  return { arrival, world, tk };
}
