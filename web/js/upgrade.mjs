/**
 * 局内三选一：升级弹窗。
 *
 * 服务端在快照里带上"这个人的待选强化"（`of`），这里只负责把它画出来、
 * 把点击换成一条 `{t:"perk", id}`。**谁能拿到哪些强化、叠加几层，全在服务端算**——
 * 前端连"我该选三个里的哪个"都不参与，它只是那三个按钮的投影。
 */

import { perkById } from "/sim/data.mjs";
import { play } from "./audio.mjs";
import { S } from "./state.mjs";

const $ = id => document.getElementById(id);

let send = () => {};

/** app 启动时把"怎么发消息"注入进来，这个模块自己不持有 socket。 */
export function bindUpgrade(sender) {
  send = sender;
}

export function showUpgrade(offers, level) {
  const box = $("upgradeCards");
  // 同一组待选项被反复推进来时，别重建 DOM——重建会让鼠标下的按钮"消失"。
  if (box.dataset.for === offers.join(",")) { $("upgradeOverlay").classList.remove("hidden"); return; }
  box.dataset.for = offers.join(",");
  box.replaceChildren();
  $("upgradeTitle").textContent = `LV.${level} · 战场进化`;
  offers.forEach((id, i) => {
    const perk = perkById(id);
    const button = document.createElement("button");
    button.className = "upgrade-card";
    button.innerHTML = `<kbd>${i + 1}</kbd><span class="upgrade-icon">${perk.icon}</span>` +
      `<small>${perk.tag}</small><strong>${perk.name}</strong><p>${perk.description}</p>` +
      `<em>${(S.mine?.pk?.[id] || 0) ? `强化至 ${S.mine.pk[id] + 1} 层` : "全新强化"}</em>`;
    button.dataset.perk = id;
    button.addEventListener("click", () => choosePerk(id));
    box.append(button);
  });
  $("upgradeOverlay").classList.remove("hidden");
  $("upgradeOverlay").querySelector(".upgrade-card")?.focus({ preventScroll: true });
}

export function hideUpgrade() {
  $("upgradeOverlay").classList.add("hidden");
  $("upgradeCards").dataset.for = "";
}

export function choosePerk(id) {
  send({ t: "perk", id });
  hideUpgrade();
  play("click");
}
