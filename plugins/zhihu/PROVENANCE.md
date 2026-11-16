# 来源与许可

本插件改编自上游开源实现，只替换运行时接口（`fetch` → `ctx.http.request`、`process.env` →
`ctx.config`/`ctx.cookies`、Node `crypto` → `ctx.crypto`、`logger` → `ctx.log`、返回结构 →
`RuleResult`）。请求顺序、字段路径、正则和签名参数保持上游原样。

| 项 | 内容 |
|---|---|
| 上游 | github.com |
| 上游文件 | src/answer.ts, src/article.ts, src/question.ts, src/status.ts, src/lib.ts, src/zhihu-sign.ts |
| 上游 commit | 24403bfe80a07f6299ea6fba5374b2f2dcec2ff1 |
| 上游 License | MIT |
| 本插件 License | MIT（见 [LICENSE](LICENSE)） |

## 改动（`@adapted`）

```
    fetch -> ctx.http.request; env.Z_C0/D_C0/ZSE_CK -> ctx.cookies.header;
```

## 有意省略（`@omitted`）

```
    HTML 页面模板、参考文献列表、origin_pin 转发渲染、专栏信息卡片；
```

文件头保留 `@source` / `@file` / `@license` / `@commit` / `@adapted` / `@omitted`，
`scripts/check-architecture.sh` 会检查前两者。
