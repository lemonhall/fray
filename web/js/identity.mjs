/**
 * 进站身份的闸门：同一时刻只认**最新那次**签发的结果。
 *
 * 为什么值得单独成模块：游客令牌里带着玩家 id（服务端靠它认"你是谁"），
 * 所以改昵称就必须重新签一张。可只要有两次签发同时在飞，"先发的后到"就会把
 * `S.token` 换掉——而建房和连 WebSocket 之间隔着好几次 await，于是同一局里会出现
 * **"房主忽然不是房主了"**：房是用令牌 A 建的（hostId=A），socket 却带着令牌 B。
 * 这个 bug 在本地毫秒级链路上几乎撞不到，一上跨境链路（几百毫秒 + 抖动）必现。
 *
 * 三条规矩集中在这里，省得各处再想一遍：
 *   1. `sign()` 只让最新的结果落到 `apply`，过期的直接丢；
 *   2. 需要身份的地方先 `ensure()`，等当前这次落定，别自己猜 `S.token` 是哪张；
 *   3. 在房间里不许重签——那等于把"我"换成另一个玩家。
 */

export function createIdentityGate(apply) {
  let epoch = 0;
  let inflight = null;
  let signed = false;

  return {
    /** 重新签发一张。返回这次签发的 promise（哪怕它过期了，调用方也能等它结束）。 */
    sign(name, signer) {
      const mine = ++epoch;
      inflight = Promise.resolve()
        .then(() => signer(name))
        .then(data => {
          if (mine === epoch) { apply(data); signed = true; }
          return data;
        });
      return inflight;
    },

    /**
     * 要身份时统一走这里：正在签就等它落定；从没签过（或上次失败了）才现签一次。
     * `sign` 是 0 参数回调，由调用方传进来，避免这个模块认识网络层。
     */
    async ensure(sign) {
      if (inflight) await inflight.catch(() => { /* 上一次失败不该炸掉这一次 */ });
      if (!signed) await sign();
      return signed;
    },

    /** 手上有没有一张当前有效的令牌。 */
    has: () => signed,
  };
}
