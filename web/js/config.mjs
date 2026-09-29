/**
 * 前端运行期配置。
 *
 * 后端地址与租户 id 都不写死在代码里：可以用 `?api=` / `?tenant=` 覆盖，也可以
 * 存进 localStorage。这样同一个静态包既能连本地 workerd，也能连线上 Worker，
 * 还能连到另一个租户上——多租户不是后端单方面的事，前端得能选。
 */

import { BUILD_API } from "./env.mjs";

const params = new URLSearchParams(location.search);
const pick = (key, fallback) => {
  const fromQuery = params.get(key);
  if (fromQuery !== null) {
    try { localStorage.setItem(`fray.${key}`, fromQuery); } catch { /* 隐私模式 */ }
    return fromQuery;
  }
  try { return localStorage.getItem(`fray.${key}`) || fallback; } catch { return fallback; }
};

/** 优先级：`?api=` > localStorage > 构建期注入 > 同源。 */
export const API = pick("api", BUILD_API).replace(/\/+$/u, "");
export const TENANT = pick("tenant", "neon");
export const apiUrl = path => `${API}${path}`;
