/**
 * 规则数据层：英雄、战术装置、进化卡、AI 难度、热点坐标。
 *
 * 纯数据 + 纯查表函数。服务端与客户端 import 同一份，所以界面上显示的数值
 * 与权威端算出来的数值天生一致，不存在"手抄一份到前端"的漂移。
 */

export const HEROS = [
  {
    name: "阿烁", en: "SPARK", role: "突击手 / ASSAULT",
    color: "#f6a64c", dark: "#be6838", light: "#ffe59d",
    hp: 4400, speed: 250, damage: 300, range: 550, reload: 1.25, interval: .36,
    shots: 3, shotSpeed: 840,
    description: "擅长正面压制的游击先锋。三连发能量脉冲，灵活、稳定、火力全开。",
    superName: "烈焰弹幕", superDescription: "11 发穿甲弹幕，摧毁前方掩体。",
    stats: [64, 74, 68],
  },
  {
    name: "铁皮", en: "RIVET", role: "重装手 / TANK",
    color: "#70c5c1", dark: "#387e80", light: "#b8e7dc",
    hp: 6800, speed: 218, damage: 290, range: 355, reload: 1.5, interval: .55,
    shots: 5, shotSpeed: 750,
    description: "一台为近身战而生的重装机甲。霰弹压制，冲锋撕开阵线。",
    superName: "震地冲锋", superDescription: "无敌突进，落点震击并破坏掩体。",
    stats: [96, 91, 40],
  },
  {
    name: "夜隼", en: "ECHO", role: "神射手 / MARKSMAN",
    color: "#b2a0d7", dark: "#70658e", light: "#e5d8ed",
    hp: 3500, speed: 257, damage: 1280, range: 790, reload: 1.65, interval: .55,
    shots: 1, shotSpeed: 1120,
    description: "游走在射程边缘的暗影狙击手。精准一击，穿透敌方防线。",
    superName: "穿云光束", superDescription: "超远光束，连续贯穿敌人与掩体。",
    stats: [48, 88, 98],
  },
  {
    name: "弧光", en: "NOVA", role: "支援手 / ENGINEER",
    color: "#ef91bc", dark: "#8f497c", light: "#ffdef0",
    hp: 4100, speed: 247, damage: 760, range: 590, reload: 1.22, interval: .47,
    shots: 1, shotSpeed: 830,
    description: "电弧弹会跳向附近另一名敌人。展开共振领域，一边治疗，一边压制。",
    superName: "共振领域", superDescription: "持续 6 秒，治疗友军并灼伤敌人。",
    stats: [60, 67, 75],
  },
];

export const BOT_NAMES = [
  "零号回声", "薄荷引擎", "镭射汽水", "像素幽灵", "霓虹游侠",
  "量子波波", "极光闪电", "机械猫", "重启玩家",
];

/** 机器人难度：伤害倍率、速度倍率、瞄准抖动、反应间隔。房主在建房时选定。 */
export const DIFFICULTIES = [
  { id: "relaxed", name: "轻松", damage: .72, speed: .86, accuracy: .17, react: .25 },
  { id: "standard", name: "标准", damage: .95, speed: .95, accuracy: .10, react: .13 },
  { id: "veteran", name: "老兵", damage: 1.1, speed: 1.04, accuracy: .045, react: .055 },
];

export const GADGETS = {
  grenade: { name: "冲击雷", icon: "grenade", cooldown: 13, description: "投出延时爆弹，造成范围伤害并摧毁掩体。13 秒冷却。" },
  shield: { name: "相位盾", icon: "shield", cooldown: 14, description: "获得 1.6 秒伤害免疫（风暴除外）。14 秒冷却。" },
  heal: { name: "修复器", icon: "heart", cooldown: 16, description: "立即恢复 33% 最大生命，可在交战中使用。16 秒冷却。" },
};

export const PERKS = [
  { id: "power", name: "高能弹头", icon: "↗", tag: "FIREPOWER", max: 3, description: "所有攻击伤害 +14%。用火力结束僵局。" },
  { id: "reload", name: "极速装填", icon: "»", tag: "TEMPO", max: 3, description: "弹药恢复速度 +22%。更持久地压制对手。" },
  { id: "vitality", name: "强化装甲", icon: "✚", tag: "SURVIVAL", max: 3, description: "增加基础生命的 18%，并立即恢复等量生命。" },
  { id: "speed", name: "轻量底盘", icon: "⇢", tag: "MOBILITY", max: 2, description: "移动速度 +12%。更快抢点，更灵活地躲弹。" },
  { id: "dash", name: "相位步伐", icon: "◇", tag: "EVASION", max: 2, description: "闪避冷却缩短 25%。每次闪避附带短暂无敌。" },
  { id: "leech", name: "能量虹吸", icon: "♡", tag: "SUSTAIN", max: 2, description: "对敌人的有效伤害转化为 8% 治疗。" },
  { id: "charge", name: "超能电池", icon: "ϟ", tag: "ULTIMATE", max: 2, description: "命中获得的超级技能能量 +30%。" },
  { id: "crit", name: "弱点解析", icon: "⌖", tag: "PRECISION", max: 2, description: "每发子弹 +16% 暴击概率，暴击伤害为 165%。" },
  { id: "ricochet", name: "折射弹道", icon: "⌁", tag: "TRICK SHOT", max: 2, description: "子弹可在墙面多反弹一次，每次反弹保留 85% 伤害。" },
  { id: "blast", name: "震荡回响", icon: "◎", tag: "AREA DAMAGE", max: 1, description: "命中时对附近其他敌人造成 30% 溅射伤害，冷却 2.5 秒。" },
  { id: "magnet", name: "战场回收", icon: "◈", tag: "RESOURCE", max: 2, description: "能量拾取距离 +90，能量块治疗量 +35%。" },
  { id: "cooling", name: "装置冷却", icon: "❄", tag: "TACTICAL", max: 2, description: "战术装置冷却缩短 25%，立即减少剩余冷却 4 秒。" },
];

export const ZONE_POINTS = [[15.5, 15.5], [8.5, 15.5], [22.5, 15.5], [15.5, 8.5], [15.5, 22.5]];

export const MODES = {
  control: { id: "control", name: "热点争夺", sub: "3V3", teams: 2, humansPerTeam: 3, maxHumans: 6, bots: 6 },
  survival: { id: "survival", name: "荒野生存", sub: "SOLO", teams: 0, maxHumans: 10, bots: 9 },
};

const PERK_INDEX = new Map(PERKS.map(p => [p.id, p]));

export const perkById = id => PERK_INDEX.get(id) || null;
export const perkOf = (actor, id) => (actor && actor.perks && actor.perks[id]) || 0;
export const heroOf = type => HEROS[((type % HEROS.length) + HEROS.length) % HEROS.length];
