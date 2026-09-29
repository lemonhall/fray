/**
 * 邀请链接：**一间房一条链接**，点开就进门。
 *
 * 为什么要单独一个模块：这件事横跨三处——地址栏参数（`?room=`）、剪贴板、以及
 * "拿到链接的人走哪条进房流程"。前两件是纯粹的浏览器知识，第三件只是复用
 * `rooms.mjs` 的进房仪式（起名 → 身份 → socket）。放在一起，`rooms.mjs` 就不会
 * 因为多了一个功能而顶破 300 行。
 *
 * 链接长这样：`https://<前端>/?room=HZRKBT`。租户不是默认值就带上 `?tenant=`，
 * 后端与前端不同域就带上 `?api=`——这两条是给多租户和"本地前端连线上后端"准备的：
 * 接链接的人不需要先配环境。
 */

import { API, TENANT } from "./config.mjs";
import { joinRoomById, notice } from "./rooms.mjs";

/** 拼一条分享链接。**只留必要参数**：别人地址栏上的东西不该跟着传播。 */
export function inviteLink(roomId) {
  const url = new URL(location.href);
  url.hash = "";
  url.search = "";
  url.searchParams.set("room", String(roomId).toUpperCase());
  if (TENANT !== "neon") url.searchParams.set("tenant", TENANT);
  // 只有跨域才写进去：同源时写它是噪音，而 `?api=` 会被 config.mjs 记进
  // localStorage，等于替接链接的人改了一次设置——能省则省。
  if (API && API !== location.origin) url.searchParams.set("api", API);
  return url.toString();
}

/** 复制到剪贴板。Clipboard API 只在安全上下文里有，所以留一条弹框的退路。 */
export async function copyInvite(roomId) {
  const link = inviteLink(roomId);
  try {
    await navigator.clipboard.writeText(link);
    notice(`邀请链接已复制，发给朋友就能直接进这间房：${link}`);
  } catch {
    window.prompt("复制这条链接发给朋友：", link);
  }
  return link;
}

/**
 * 开局时认一次 `?room=`：拿到链接的人不该还要回列表里翻房间。
 *
 * 认完立刻把参数从地址栏抹掉——留着的话，玩家自己退出房间之后再刷新，
 * 会被手里那张链接莫名其妙地拽回去，而且说不清是谁干的。
 */
export async function joinFromLink() {
  const raw = new URLSearchParams(location.search).get("room") || "";
  // 房间码是大小写敏感的字母表里生成的（`src/lobby.mjs` 的 ALPHABET 全大写），
  // 但人转链接的时候会把它写小——所以这里统一成大写再进。
  const wanted = raw.trim().toUpperCase();
  if (!wanted) return false;
  stripRoomParam();
  await joinRoomById(wanted);
  return true;
}

function stripRoomParam() {
  try {
    const url = new URL(location.href);
    url.searchParams.delete("room");
    history.replaceState(null, "", url.toString());
  } catch { /* 地址栏不让动就算了，进房要紧 */ }
}
