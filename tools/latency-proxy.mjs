/**
 * 延迟注入代理：一个纯 TCP 转发器，塞在浏览器和 `wrangler dev` 之间。
 *
 * 为什么要它：跨境链路上"人往前走了又被拽回一小段"这类手感 bug，在 localhost
 * 上永远复现不出来——RTT 0.2ms 的时候预测和权威位置几乎重合。把这条代理挂上去，
 * 就得到一个可复现、可量化、**不花钱**（不碰线上账号）的高延迟环境。
 *
 * 它故意工作在 TCP 这一层，而不是 HTTP/WebSocket 那一层：所有字节同等对待，
 * HTTP 请求、WebSocket 握手、以及每一条对局消息都经过同一段延迟——真实链路就是
 * 这样的，分开处理反而会造出一个不存在的"干净通道"。
 *
 * 延迟模型：
 *   - `delayMs`   基线单向延迟（跨境到 CF 边缘大概 80~150ms）；
 *   - `jitterMs`  每个数据块的额外随机延迟（只加不减，模拟排队）；
 *   - `stall`     周期性拥塞窗口：窗口期内到的包全压到窗口结束一起发，
 *                 这就是"世界冻结两百毫秒然后猛追一截"的来源。
 */

import net from "node:net";

const now = () => Date.now();

/** 单个方向：到的每一块按 FIFO 顺序、各自带上自己的释放时刻发出去（绝不重排序）。 */
function pipe(from, to, cfg) {
  const queue = [];
  let timer = null;

  const releaseAt = () => {
    let extra = 0;
    if (cfg.jitterMs) extra += Math.random() * cfg.jitterMs;
    if (cfg.stall) {
      const phase = (now() - cfg.stall.t0) % cfg.stall.everyMs;
      if (phase < cfg.stall.holdMs) extra += cfg.stall.holdMs - phase;
    }
    return now() + cfg.delayMs + extra;
  };

  const flush = () => {
    timer = null;
    const t = now();
    let chunk = null;
    while (queue.length && queue[0].at <= t) {
      const item = queue.shift();
      chunk = chunk ? Buffer.concat([chunk, item.buf]) : item.buf;
    }
    if (chunk && !to.destroyed) to.write(chunk);
    if (queue.length) arm();
  };

  const arm = () => {
    if (timer) return;
    timer = setTimeout(flush, Math.max(0, queue[0].at - now()));
  };

  from.on("data", buf => {
    queue.push({ at: releaseAt(), buf });
    arm();
  });
}

/**
 * 起一个代理。返回 `{ port, close, stats }`——`stats` 里是两条方向的流量，
 * 用来确认"确实有字节流过"，而不是浏览器悄悄走了别的地址。
 */
export function startLatencyProxy({
  port = 8899, targetPort = 8790, host = "127.0.0.1",
  delayMs = 100, jitterMs = 30, stallMs = 0, stallEveryMs = 4000,
} = {}) {
  const cfg = {
    delayMs, jitterMs,
    stall: stallMs > 0 ? { holdMs: stallMs, everyMs: stallEveryMs, t0: now() } : null,
  };
  const stats = { conns: 0, up: 0, down: 0 };
  const server = net.createServer(client => {
    stats.conns++;
    client.setNoDelay(true);
    const upstream = net.connect({ host, port: targetPort });
    upstream.setNoDelay(true);
    // 立刻挂上两个方向，而不是等 connect：客户端的第一批字节（HTTP 请求 / WS 握手）
    // 往往比上游连接建立得更早，等 connect 再挂就等于把它们丢了。
    // 还没连上时写 socket 是安全的，Node 会先缓冲。
    pipe(client, upstream, cfg);
    pipe(upstream, client, cfg);
    client.on("data", () => stats.up++);
    upstream.on("data", () => stats.down++);
    const kill = () => { client.destroy(); upstream.destroy(); };
    client.on("error", kill);
    upstream.on("error", kill);
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, host, () => resolve({
      port,
      url: `http://${host}:${port}`,
      stats,
      close: () => new Promise(done => server.close(() => done())),
    }));
  });
}

/** 直接 `node tools/latency-proxy.mjs` 跑起来自测用（默认挂在 8790 前面）。 */
if (import.meta.filename === process.argv[1]) {
  const proxy = await startLatencyProxy({
    port: Number(process.env.PROXY_PORT) || 8899,
    targetPort: Number(process.env.PROXY_TARGET) || 8790,
    delayMs: Number(process.env.PROXY_DELAY) || 100,
    jitterMs: Number(process.env.PROXY_JITTER) || 30,
    stallMs: Number(process.env.PROXY_STALL) || 0,
  });
  console.log(`延迟代理已启动：${proxy.url} → 127.0.0.1:${Number(process.env.PROXY_TARGET) || 8790}`);
  console.log(`单向 ${Number(process.env.PROXY_DELAY) || 100}ms + 抖动 ${Number(process.env.PROXY_JITTER) || 30}ms`);
  console.log("按 Ctrl+C 退出。");
}
