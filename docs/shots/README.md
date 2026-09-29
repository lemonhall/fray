# 截图来源

这四张图不是本地开发环境的画面，而是**生产环境**的实拍：

* 站点：<https://fray.lemonhall.me>（Vercel 上的前端；拍照那天还挂在 `fray-seven.vercel.app`）
* 后端：<https://fray-api.lemonhall.me>（Cloudflare Workers + Durable Objects）
* 时间：2026-09-29

拍法：Playwright 驱动本机 Chrome（1440×900，`channel:"chrome"`）真的打开线上站点，
走一遍"进站 → 看到别人的桌子 → 自己开一桌 + 放 5 个机器人 → 第二个真人从列表加入 →
房主开打 → 混战开火"，在四个节点截图。也就是说，图和线上跑的是同一条链路，
没有为了截图临时造数据。

| 文件 | 拍到的瞬间 |
|---|---|
| `00-rooms-list.png` | 房间浏览器：两张别人开的桌子（荒野生存 / 热点争夺 3v3） |
| `02-lobby.png` | 候场：名册里 1 名真人 + 5 个机器人，房主可调人数 |
| `03-arena.png` | 刚进场：地图 seed 已下发，第一帧权威快照已到 |
| `05-brawl.png` | 混战：占点圈、队友、补给箱、HUD 全在跑 |
