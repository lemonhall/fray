/**
 * 起名闸门：**进房之前先问一次名字**，之后存在 localStorage 里。
 *
 * 为什么要单独一个模块：名字有两份身份——一份是玩家的体面（名册、击杀播报、排行榜
 * 都写着它），一份是服务端的令牌（名字签在令牌里）。所以"什么时候问"和"什么时候
 * 重签令牌"必须分开写：这个文件只管前者，重签仍然由 `rooms.mjs` 的身份闸门决定。
 *
 * 之前的样子是：大厅里有个昵称输入框，默认空着，`nickname()` 兜底成"游客"。于是
 * 所有人进来都叫同一个名字，房主根本分不清谁是谁。现在改成"第一次进房必问一次"。
 */

const $ = id => document.getElementById(id);
const NAME_KEY = "fray.name";

export function readName() {
  try { return (localStorage.getItem(NAME_KEY) || "").trim().slice(0, 16); } catch { return ""; }
}

export function writeName(value) {
  const name = String(value || "").trim().slice(0, 16);
  try { localStorage.setItem(NAME_KEY, name); } catch { /* 隐私模式：认了，只是记不住 */ }
  return name;
}

/** "随便给一个"用：好认、不重名、不需要玩家动脑子。 */
export function randomName() {
  return `夜行者${Math.floor(Math.random() * 9000) + 1000}`;
}

let resolveAsk = null;

/**
 * 弹一次窗，返回玩家敲定的名字；玩家按取消/ESC 就返回空字符串。
 *
 * 同一时间只允许有一个提问（`resolveAsk` 就是那道锁）：连点两张房间卡片会让
 * 两个 promise 抢同一个输入框，先关掉的那个才是玩家的真实意图——所以第二次
 * 调用直接复用正在问的那一次。
 */
export function askName(current = readName()) {
  const backdrop = $("nameBackdrop");
  if (resolveAsk) return resolveAsk;
  const input = $("nameInput");
  input.value = current;
  $("nameError").classList.add("hidden");
  backdrop.classList.remove("hidden");
  setTimeout(() => { input.focus(); input.select(); }, 30);

  resolveAsk = new Promise(resolve => {
    const finish = value => {
      backdrop.classList.add("hidden");
      document.removeEventListener("keydown", onKey, true);
      $("nameConfirm").removeEventListener("click", onConfirm);
      $("nameSkip").removeEventListener("click", onSkip);
      backdrop.removeEventListener("click", onBackdrop);
      resolveAsk = null;
      resolve(value);
    };
    const take = raw => {
      const name = String(raw || "").trim().slice(0, 16);
      if (!name) {
        $("nameError").classList.remove("hidden");
        input.focus();
        return;
      }
      finish(writeName(name));
    };
    const onConfirm = () => take(input.value);
    const onSkip = () => finish(writeName(input.value.trim() || randomName()));
    const onKey = event => {
      if (event.key === "Enter") { event.preventDefault(); take(input.value); }
      if (event.key === "Escape") { event.preventDefault(); finish(""); }
    };
    // 点遮罩等于取消：这是"我不想进去"最自然的表达，不该被当成"随便给个名字"。
    const onBackdrop = event => { if (event.target === backdrop) finish(""); };
    $("nameConfirm").addEventListener("click", onConfirm);
    $("nameSkip").addEventListener("click", onSkip);
    document.addEventListener("keydown", onKey, true);
    backdrop.addEventListener("click", onBackdrop);
  });
  return resolveAsk;
}

/** 进房 / 建房 / 快速匹配之前的统一入口：有名字直接用，没有就问。 */
export async function ensureName() {
  const known = readName();
  return known || askName("");
}
