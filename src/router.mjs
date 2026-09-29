/**
 * 极简路由：把 `GET /v1/:tenant/rooms/:roomId` 这样的模式编译成正则。
 *
 * 不引第三方框架。理由不是"自己写更酷"，而是这个 Worker 只有十来个端点，
 * 一个 60 行的匹配器比任何框架都更容易一眼看完全貌。
 */

export function compile(pattern) {
  const keys = [];
  const source = pattern
    .split("/")
    .map(seg => {
      if (seg.startsWith(":")) { keys.push(seg.slice(1)); return "([^/]+)"; }
      return seg.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    })
    .join("/");
  return { regex: new RegExp(`^${source}/?$`, "u"), keys };
}

export function createRouter() {
  const routes = [];
  const add = (method, pattern, handler) => routes.push({ method, ...compile(pattern), handler });
  return {
    get: (p, h) => add("GET", p, h),
    post: (p, h) => add("POST", p, h),
    delete: (p, h) => add("DELETE", p, h),
    match(method, pathname) {
      for (const route of routes) {
        if (route.method !== method) continue;
        const m = route.regex.exec(pathname);
        if (!m) continue;
        const params = {};
        route.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        return { handler: route.handler, params };
      }
      return null;
    },
  };
}
