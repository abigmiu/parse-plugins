# 来源与许可

本插件改编自上游开源实现，只替换运行时接口（`fetch` → `ctx.http.request`、`process.env` →
`ctx.config`/`ctx.cookies`、Node `crypto` → `ctx.crypto`、`logger` → `ctx.log`、返回结构 →
`RuleResult`）。请求顺序、字段路径、正则和签名参数保持上游原样。

| 项 | 内容 |
|---|---|
| 上游 | github.com |
| 上游文件 | packages/parse-core/src/lib/xhsCore.js |
| 上游 commit | 17603b8a5404b4dc7408b5c44dae441ea9d2996f |
| 上游 License | MIT |
| 本插件 License | MIT（见 [LICENSE](LICENSE)） |

## 改动（`@adapted`）

```
    fetchWithTimeout/fetch(redirect:"manual") -> ctx.http.request（宿主
    请求头只保留 User-Agent / Accept / Accept-Language / Cookie，并显式发送
```

## 有意省略（`@omitted`）

```
    博主主页统计与 profile token（RuleResult 没有对应字段）、互动统计、
```

文件头保留 `@source` / `@file` / `@license` / `@commit` / `@adapted` / `@omitted`，
`scripts/check-architecture.sh` 会检查前两者。
