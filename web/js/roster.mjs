/**
 * 候场名册的渲染：一张卡片一个人，房主的手上多一把"请出去"。
 *
 * 名册要在一眼之内回答四个问题：**这是谁、在哪一队、举手了没有、房主要不要踢他**。
 * 所以卡片上的信息密度是刻意堆的：队色描边、状态小字、等待秒数、房主专属的踢人按钮。
 * 界面永远不是安全边界（服务端还会再拦一次），但"谁在磨蹭"必须让房主看得见——
 * 否则"踢掉那个一直不 ready 的"只能凭印象。
 */

import { HEROS } from "/sim/data.mjs";
import { drawPortrait } from "./showcase.mjs";

const $ = id => document.getElementById(id);
const TEAM_NAMES = ["蓝队", "红队"];

/** 人到底在哪个状态：房主 / 已举手 / 还在磨蹭（附等了多久）。 */
function statusOf(view, member) {
  if (member.id === view.host) return { text: "房主", cls: "" };
  if (member.rdy) return { text: "已就绪", cls: "" };
  const seconds = Math.max(0, Math.round((member.wait || 0) / 1000));
  return { text: seconds >= 5 ? `等待 ${seconds}s` : "等待确认", cls: "waiting" };
}

const sideOf = member => (member.tm === 0 || member.tm === 1 ? TEAM_NAMES[member.tm] : "自动");

function humanChip(view, member, hooks) {
  const chip = document.createElement("div");
  const side = member.tm === 0 || member.tm === 1 ? member.tm : -1;
  const status = statusOf(view, member);
  chip.className = `roster-chip${member.me ? " me" : ""}${side >= 0 ? ` t${side}` : ""}` +
    `${status.cls ? ` ${status.cls}` : ""}`;

  const canvas = document.createElement("canvas");
  canvas.width = 26; canvas.height = 26;
  const label = document.createElement("div");
  const strong = document.createElement("span");
  strong.textContent = member.n;
  const small = document.createElement("small");
  small.textContent = `${HEROS[member.hero].name} · ${status.text}`;
  const sideLabel = document.createElement("span");
  sideLabel.className = "chip-side";
  sideLabel.textContent = view.teams ? sideOf(member) : "混战";
  label.append(strong, small, sideLabel);
  chip.append(canvas, label);
  drawPortrait(canvas, member.hero);

  if (member.id === view.host) {
    const crown = document.createElement("span");
    crown.className = "host-crown";
    crown.textContent = "★";
    chip.append(crown);
  } else if (hooks.canKick) {
    const kick = document.createElement("button");
    kick.type = "button";
    kick.className = "kick-button";
    kick.dataset.kick = member.id;
    kick.textContent = "请出去";
    kick.title = `把 ${member.n} 请出房间（十分钟内不许再进）`;
    kick.addEventListener("click", () => hooks.onKick(member.id));
    chip.append(kick);
  }
  return chip;
}

function botChip(index) {
  const chip = document.createElement("div");
  chip.className = "roster-chip bot";
  const crown = document.createElement("span");
  crown.className = "host-crown";
  crown.textContent = "🤖";
  const label = document.createElement("div");
  const strong = document.createElement("span");
  strong.textContent = "机器人";
  const small = document.createElement("small");
  small.textContent = `BOT ${index + 1}`;
  label.append(strong, small);
  chip.append(crown, label);
  return chip;
}

/**
 * 每次收到房间广播都会整块重画。
 *
 * 不做 diff 是刻意的：一个房间最多十来个格子，重画的代价远小于"状态同步错一格"
 * 的代价；而 `replaceChildren` 之后按钮的事件又是全新的，不会残留旧的闭包。
 */
export function renderRoster(view, hooks) {
  const box = $("rosterRows");
  box.replaceChildren();
  // 只有房主、只有在候场，才有"请出去"这把刀——对局中踢人要另说（脚本里也拦着）。
  const canKick = !!(view.you && view.you.host) && view.ph === "staging";
  for (const member of view.members) {
    box.append(humanChip(view, member, { ...hooks, canKick }));
  }
  for (let i = 0; i < view.bots; i++) box.append(botChip(i));
}
