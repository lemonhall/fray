/**
 * 音效：全部靠 WebAudio 现场合成，不下载任何音频文件。
 *
 * 现场合成没有网络等待，也就不会出现"枪都打完了才听见声音"。
 * 音量按事件到我的距离衰减——这是多人射击里"听声辨位"的最低配版本。
 */

let audio = null;
let enabled = true;

export function initAudio() {
  if (!enabled) return;
  try {
    if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === "suspended") audio.resume().catch(() => {});
  } catch { /* 浏览器不给就算了 */ }
}

export const soundOn = () => enabled;
export function toggleSound() { enabled = !enabled; if (enabled) initAudio(); return enabled; }

export function tone(freq, duration, type = "sine", volume = .045, slide = 0, delay = 0) {
  if (!enabled || !audio || audio.state !== "running") return;
  try {
    const osc = audio.createOscillator(), gain = audio.createGain(), t = audio.currentTime + delay;
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(25, freq + slide), t + duration);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(volume, t + .007);
    gain.gain.exponentialRampToValueAtTime(.001, t + duration);
    osc.connect(gain); gain.connect(audio.destination);
    osc.start(t); osc.stop(t + duration + .01);
  } catch { /* 一次音效失败不该影响对局 */ }
}

const RECIPES = {
  shot: a => tone(420, .07, "triangle", .027 * a, -220),
  sniper: a => { tone(790, .12, "sawtooth", .023 * a, -650); tone(100, .15, "sine", .035 * a); },
  hit: a => tone(160, .09, "triangle", .034 * a, -80),
  cube: a => { tone(660, .1, "sine", .05 * a, 100); tone(990, .16, "sine", .045 * a, 100, .075); },
  kill: a => { tone(440, .13, "square", .022 * a, 80); tone(660, .17, "triangle", .04 * a, 0, .12); tone(880, .23, "triangle", .04 * a, 0, .23); },
  super: a => { tone(130, .4, "sawtooth", .04 * a, 450); tone(70, .4, "sine", .07 * a, 0); },
  dash: a => tone(400, .16, "sine", .04 * a, -290),
  click: a => tone(800, .06, "sine", .03 * a, 70),
  explode: a => { tone(90, .3, "sawtooth", .05 * a, -40); tone(180, .18, "square", .03 * a, -120); },
  start: () => [330, 440, 660, 880].forEach((f, i) => tone(f, .18, "triangle", .04, 0, i * .09)),
  win: () => [523, 659, 784, 1047, 784, 1047].forEach((f, i) => tone(f, .3, "triangle", .04, 0, i * .15)),
  lose: () => [330, 294, 220].forEach((f, i) => tone(f, .3, "triangle", .04, 0, i * .18)),
};

export function play(kind, volume = 1) {
  const recipe = RECIPES[kind];
  if (recipe) recipe(volume);
}

export function playEvent(S, ev) {
  if (!enabled) return;
  const mine = ev.from && S.me && ev.from === S.me.i;
  if (ev.to && S.me && ev.to === S.me.i && !ev.from) { play(ev.s, 1); return; }
  let volume = 1;
  if (!mine && S.me) {
    const d = Math.hypot(ev.x - S.me.x, ev.y - S.me.y);
    if (d > 1100) return;
    volume = Math.max(.12, 1 - d / 1100);
  }
  play(ev.s, volume);
}
