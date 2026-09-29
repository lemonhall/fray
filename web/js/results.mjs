/**
 * 结算页：把服务端算出来的名次、奖励、构筑原样摆出来。
 *
 * 名次是**权威端**算的（`sim/flow.mjs` 的 `endMatch`），客户端一个数都不改。
 * 唯一写在本地的是生涯经验——那是"我的浏览器替我记的账"，不是对局结果。
 */

import { clock } from "/sim/constants.mjs";
import { addCareer } from "./showcase.mjs";
import { S } from "./state.mjs";

const $ = id => document.getElementById(id);

export function showResults(results) {
  const me = (results.players || []).find(p => p.ownerId === S.meId) || null;
  const control = results.kind === "control";
  const myTeam = me ? me.team : 0;
  const win = control
    ? results.winnerTeam >= 0 && results.winnerTeam === myTeam
    : !!me && me.rank === 1;
  const rank = me ? me.rank : 0;

  $("resultEyebrow").textContent = win ? "MISSION ACCOMPLISHED" : "MATCH COMPLETE";
  $("resultRank").textContent = control ? (win ? "VICTORY" : "DEFEAT") : "#" + rank;
  $("resultRank").style.color = win ? "#64efd2" : "#edb0ba";
  $("resultTitle").textContent = control
    ? (win ? "漂亮的配合。" : "下一次，夺回来。")
    : win ? "荒野之王！" : rank <= 3 ? "距离胜利，仅一步。" : "换种打法，再来。";
  $("resultDescription").textContent = control
    ? `热点争夺 · 我方 ${results.score[myTeam === 0 ? 0 : 1]} : ${results.score[myTeam === 0 ? 1 : 0]} 敌方` +
      (me ? ` · 个人占点 ${me.capture} 秒` : "")
    : win ? "你的构筑，经受住了最后的考验。" : "保留弹药，争夺补给，试试新的强化组合。";

  $("resultKills").textContent = me ? me.kills : 0;
  $("resultDamage").textContent = (me ? me.damage : 0).toLocaleString("zh-CN");
  $("resultTime").textContent = typeof results.duration === "string" ? results.duration : clock(results.duration || 0);
  $("resultXP").textContent = `+${me ? me.reward : 0} XP`;
  $("resultContracts").textContent = `本局构筑 ${me ? me.build.length : 0} 张进化卡`;
  $("resultBuild").innerHTML = buildChips(me);
  $("resultRecord").textContent = `房主点「再来一局」就能重开 · 奖励只记在本地生涯`;

  addCareer({ xp: me ? me.reward : 0, win });
  confetti(win);
  $("results").classList.remove("hidden");
  $("screenReaderStatus").textContent = control
    ? (win ? "我方获胜。" : "敌方获胜。")
    : `对局结束，第${rank}名。`;
  $("playAgainButton").focus({ preventScroll: true });
}

export function hideResults() {
  $("results").classList.add("hidden");
  $("resultEyebrow").textContent = "MATCH COMPLETE";
  $("resultTitle").textContent = "漂亮的配合。";
}

function buildChips(me) {
  if (!me || !me.build.length) return '<span class="perk-chip">本局未获取进化 · 下次试试抢先占点</span>';
  return me.build.map(p => `<span class="perk-chip">${p.name}${p.n > 1 ? " ×" + p.n : ""}</span>`).join("");
}

function confetti(win) {
  const box = $("confetti");
  box.replaceChildren();
  if (!win || matchMedia("(prefers-reduced-motion:reduce)").matches) return;
  const colors = ["#65efd7", "#ffbb7b", "#b8a1ff", "#c5eaff"];
  for (let i = 0; i < 40; i++) {
    const bit = document.createElement("i");
    bit.style.left = Math.random() * 100 + "%";
    bit.style.animationDelay = Math.random() * 4 + "s";
    bit.style.animationDuration = 3 + Math.random() * 2 + "s";
    bit.style.background = colors[i % 4];
    box.append(bit);
  }
}

/** 「再来一局」的语义：房主能重开，其他人只能回到候场等。 */
export function bindResults({ onReset, onBack }) {
  $("playAgainButton").addEventListener("click", () => onReset?.());
  $("lobbyButton").addEventListener("click", () => onBack?.());
  $("lobbyButton").textContent = "回到房间候场";
}
