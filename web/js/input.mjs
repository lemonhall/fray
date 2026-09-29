/**
 * 输入采集：键盘、鼠标、触屏虚拟摇杆 → 一帧网络输入。
 *
 * 输入是**意图**：往哪走、准星在哪、开火键按着没有。客户端的坐标从不上行——
 * 这是"改一行 JS 就能瞬移"的唯一根治法。
 */

const MOVE_KEYS = ["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];

export function attachInput(S, { canvas, onKey }) {
  document.addEventListener("keydown", event => {
    if (event.code === "Space" || MOVE_KEYS.includes(event.code)) event.preventDefault();
    S.keys.add(event.code);
    onKey?.(event);
  });
  document.addEventListener("keyup", event => S.keys.delete(event.code));
  window.addEventListener("blur", () => clearInputs(S));

  canvas.addEventListener("pointermove", event => {
    if (event.pointerType === "touch") return;
    const rect = canvas.getBoundingClientRect();
    S.mouse.x = event.clientX - rect.left;
    S.mouse.y = event.clientY - rect.top;
    S.mouse.known = true;
  });
  canvas.addEventListener("pointerdown", event => {
    if (event.pointerType === "touch") return;
    event.preventDefault();
    initFromPointer(S, canvas, event);
    if (event.button === 0) S.mouse.down = true;
    if (event.button === 2) S.actions |= 4;
  });
  window.addEventListener("pointerup", event => { if (event.pointerType !== "touch") S.mouse.down = false; });
  window.addEventListener("pointercancel", () => { S.mouse.down = false; });
  canvas.addEventListener("contextmenu", event => event.preventDefault());
}

function initFromPointer(S, canvas, event) {
  const rect = canvas.getBoundingClientRect();
  S.mouse.x = event.clientX - rect.left;
  S.mouse.y = event.clientY - rect.top;
  S.mouse.known = true;
}

export function clearInputs(S) {
  S.keys.clear();
  S.mouse.down = false;
  S.actions = 0;
  S.touch.move = { x: 0, y: 0 };
  S.touch.aim = { x: 0, y: 0, active: false };
  document.querySelectorAll(".joystick>i").forEach(node => { node.style.transform = "translate(0px,0px)"; });
}

/** 触屏摇杆：左摇杆移动，右摇杆瞄准（轻点一下 = 辅助射击）。 */
export function bindStick(S, el, aim) {
  const knob = el.querySelector("i");
  let pointer = null, start = null, moved = false, startedAt = 0;
  const set = event => {
    const rect = el.getBoundingClientRect();
    const limit = rect.width * .31;
    const dx = event.clientX - rect.left - rect.width / 2;
    const dy = event.clientY - rect.top - rect.height / 2;
    const len = Math.hypot(dx, dy);
    const scale = len > limit ? limit / len : 1;
    knob.style.transform = `translate(${dx * scale}px,${dy * scale}px)`;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) moved = true;
    const nx = dx * scale / limit, ny = dy * scale / limit;
    if (aim) S.touch.aim = { x: nx, y: ny, active: len > 9 };
    else S.touch.move = { x: nx, y: ny };
  };
  el.addEventListener("pointerdown", event => {
    if (pointer !== null) return;
    event.preventDefault();
    pointer = event.pointerId;
    el.setPointerCapture(pointer);
    start = { x: event.clientX, y: event.clientY };
    startedAt = performance.now();
    moved = false;
    set(event);
  });
  el.addEventListener("pointermove", event => { if (event.pointerId === pointer) { event.preventDefault(); set(event); } });
  const release = event => {
    if (event.pointerId !== pointer) return;
    if (aim && event.type !== "pointercancel" && !moved && performance.now() - startedAt < 300) S.actions |= 4;
    pointer = null;
    knob.style.transform = "translate(0px,0px)";
    if (aim) S.touch.aim = { x: 0, y: 0, active: false };
    else S.touch.move = { x: 0, y: 0 };
  };
  el.addEventListener("pointerup", release);
  el.addEventListener("pointercancel", release);
}

export function moveBits(S) {
  const keys = S.keys;
  const up = keys.has("KeyW") || keys.has("ArrowUp") ? 1 : 0;
  const right = keys.has("KeyD") || keys.has("ArrowRight") ? 1 : 0;
  const down = keys.has("KeyS") || keys.has("ArrowDown") ? 1 : 0;
  const left = keys.has("KeyA") || keys.has("ArrowLeft") ? 1 : 0;
  return (up ? 1 : 0) | (right ? 2 : 0) | (down ? 4 : 0) | (left ? 8 : 0);
}

export function moveVector(S) {
  const bits = moveBits(S);
  return {
    x: (bits & 2 ? 1 : 0) - (bits & 8 ? 1 : 0) + S.touch.move.x,
    y: (bits & 4 ? 1 : 0) - (bits & 1 ? 1 : 0) + S.touch.move.y,
  };
}

/** 准星世界坐标 → 角度。没有准星（纯键盘/触屏）时退化成"朝移动方向"。 */
export function aimAngle(S, player) {
  if (S.touch.aim.active && Math.hypot(S.touch.aim.x, S.touch.aim.y) > .12) {
    return Math.atan2(S.touch.aim.y, S.touch.aim.x);
  }
  if (S.mouse.known) {
    const wx = S.cam.x + (S.mouse.x - S.view.w / 2) / S.view.zoom;
    const wy = S.cam.y + (S.mouse.y - S.view.h / 2) / S.view.zoom;
    return Math.atan2(wy - player.y, wx - player.x);
  }
  const v = moveVector(S);
  return Math.hypot(v.x, v.y) > .1 ? Math.atan2(v.y, v.x) : player.angle;
}

export function aimRange(S, player) {
  if (!S.mouse.known || S.touch.aim.active) return 310;
  const wx = S.cam.x + (S.mouse.x - S.view.w / 2) / S.view.zoom;
  const wy = S.cam.y + (S.mouse.y - S.view.h / 2) / S.view.zoom;
  return Math.max(55, Math.min(380, Math.hypot(wx - player.x, wy - player.y)));
}

/*
 * 上行报文的组装**不在这里**：一帧输入要经过"命令时间线"（方向变了就切命令、
 * 每格计数、收尾发送），那套东西住在 `cmd.mjs`。这一层只回答四个问题：
 * 往哪走、朝哪看、看多远、按着哪些键。
 */
