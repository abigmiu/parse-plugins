# 小红书规则（xiaohongshu）

## 来源

- 上游：`hotier/MediaGet`
- 文件：`packages/parse-core/src/lib/xhsCore.js`（947 行）
- License：MIT
- commit：`17603b8a5404b4dc7408b5c44dae441ea9d2996f`
- 依赖参考：`quality.js`、`http.ts`、`api-utils.js`、`redirect-location.ts`

`rule.mjs` 负责请求编排和错误码，`xhs-extract.mjs` 是上游纯函数的逐段适配。

## 适配点

| 上游 | 规则 |
|---|---|
| `fetch` / `fetchWithTimeout` + 手动 Location 循环 | `ctx.http.request`，宿主 Cookie jar 自动保存 Set-Cookie 并跟随重定向 |
| `getConfigOrEnv("xhsCookie", "XHS_COOKIE")` + 模块级 Cookie 池 | `ctx.cookies.header` + 宿主每请求独立 Cookie jar |
| `logger` / `console.log` | `ctx.log` |
| `{ code, msg, data }` | `RuleResult`；登录墙/风控/404 映射到 `COOKIE_REQUIRED` / `RISK_CONTROL` / `MEDIA_NOT_FOUND` |
| 完整浏览器头（sec-ch-ua / sec-fetch-* / Cache-Control） | 只保留 UA / Accept / Accept-Language / Cookie / 空 Accept-Encoding |

### 为什么精简请求头

- 上游的桌面 Edge 完整头在非中国大陆出口会被判成爬虫，实测 302 到 `/login` 或
  `/website-login/captcha`。
- Go `net/http` 默认会补 `Accept-Encoding: gzip`；小红书对带该头的请求直接 302 到
  `/login`。规则发送单个空格作为值，阻止 Go 自动补头，服务端按空头处理。
- 上述两点是平台请求特征，必须留在 JS 规则内，不能改宿主。

## 相对上游的扩展

**实况图 `live_photo_url`**：上游只输出静态图 URL。这里在
`noteData.imageList[i].livePhoto === true` 时，复用同一套视频档位选择逻辑
（`collectVideoEntries` + `pickStableVideoUrl`）从 `imageList[i].stream` 选出实况视频，
填到 `media[].live_photo_url`（`xhs-extract.mjs` 的 `buildImageMedia`，带注释）。

## 有意省略

- 博主主页统计（关注/粉丝/获赞与收藏）、`xsec_token` 主页抓取和 10 分钟缓存：
  `RuleResult` 没有对应字段。
- 互动统计：`RuleResult` 没有对应字段。
- 模块级 Cookie 池 / 主页缓存：违反“规则不依赖模块级可变状态”，改由宿主 Cookie jar 承担。

## 输出差异（与旧 Go/Python 实现）

- 视频笔记返回 `type=video`、`videos` 1 条，封面在顶层 `cover` / `videos[].cover`；
  不再额外生成一张图片 media（上游 JS 的结构如此）。
- 图文笔记返回 `type=image`，`images[]` 数量与 `imageList` 一致；实况图每项都有
  `live_photo_url`。

## 离线 fixture

`fixtures/{video,live,image}/fixture.json` + `note.html`，响应已脱敏
（`xsec_token`、`sign`、`t`、`appuid`、`share_id`、`shareRedId`）。

测试：在引擎仓库里 `./scripts/dev-plugins.sh` 之后 `go test ./internal/ruletests -run Xiaohongshu`

## 真实链接回归（2026-11-03）

| 链接 | 结果 |
|---|---|
| `https://xhslink.cn/o/44wsXQm4HdU` | `video`，1 个视频，23 秒，标题《06年女生相亲，我妈让我打扮成熟点，于是我..》 |
| `https://xhslink.cn/o/397e7rxfJF1` | `image`，5 张图，5 个 `live_photo_url` 均非空 |
| `https://xhslink.cn/o/9efgISfob4M` | `image`，1 张图 |

## 已知限制

- 小红书对无 Cookie / 数据中心出口会间歇返回登录墙或安全验证；对应返回
  `COOKIE_REQUIRED` / `RISK_CONTROL`，不启动浏览器。
- 实况视频地址优先取 `backupUrls`（长期有效），`masterUrl` 带约 30 分钟签名，仅兜底。
