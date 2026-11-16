# 来源与许可

本插件改编自上游开源实现，只替换运行时接口（`fetch` → `ctx.http.request`、`process.env` →
`ctx.config`/`ctx.cookies`、Node `crypto` → `ctx.crypto`、`logger` → `ctx.log`、返回结构 →
`RuleResult`）。请求顺序、字段路径、正则和签名参数保持上游原样。

| 项 | 内容 |
|---|---|
| 上游 | github.com |
| 上游文件 | 无（本规则是宿主能力适配层，不复制上游代码） |
| 上游 commit | 无（未绑定上游版本；能力由本机安装的 yt-dlp 提供） |
| 上游 License | Unlicense |
| 本插件 License | MIT（见 [LICENSE](LICENSE)） |

## 改动（`@adapted`）

```
    直接调用 ctx.native.ytdlp.resolve，挑选 progressive 格式并映射为 RuleResult
```

## 有意省略（`@omitted`）

```
    —
```

文件头保留 `@source` / `@file` / `@license` / `@commit` / `@adapted` / `@omitted`，
`scripts/check-architecture.sh` 会检查前两者。
