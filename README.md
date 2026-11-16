# self-parse 插件集合

[self-parse](https://github.com/abigmiu/parse) 的插件仓库，一个仓库放全部插件。
引擎本身不带任何插件，装哪个就有哪个平台。

| 插件 | id | 说明 |
|---|---|---|
| [抖音](plugins/douyin) | `douyin` | 抖音分享链接解析（视频/图文） |
| [小红书](plugins/xiaohongshu) | `xiaohongshu` | 小红书笔记解析（视频/图文/实况图） |
| [B 站](plugins/bilibili) | `bilibili` | 哔哩哔哩视频/专栏解析 |
| [X（推特）](plugins/x) | `x` | X/Twitter 推文解析（视频/多图/长文/Article） |
| [知乎](plugins/zhihu) | `zhihu` | 知乎回答/问题/专栏/想法解析（正文 + 图片/视频） |
| [yt-dlp（通用兜底）](plugins/ytdlp) | `ytdlp` | 调用宿主 yt-dlp 能力的通用兜底规则（兜底规则，建议先装） |

## 安装单个插件

每个发行版（Release）都附带每个插件的独立 zip（`<id>.zip`，`plugin.json` 在 zip 根目录）：

1. 打开 [Releases](https://github.com/abigmiu/parse-plugins/releases)，下载需要的 `<id>.zip`
2. 上传安装：

```bash
curl -X POST http://127.0.0.1:8051/api/plugins/install   -H "X-Parse-Token: <令牌>" -H "Content-Type: application/zip" \
  --data-binary @douyin.zip
```

也可以直接把 `plugins/<id>/` 拷进引擎的插件目录（`PARSE_PLUGINS_DIR`）。
注意：GitHub 的 Download ZIP 打的是整仓，里面是 6 个插件的目录，**不能**直接上传安装。

## 目录结构

```text
plugins.json            # 单一真相：id / 名称 / 版本 / 目录 / 说明
plugins/<id>/           # 一个插件一个目录，根目录下就是 plugin.json
  plugin.json  rule.mjs  *.mjs
  fixtures/<case>/      # 离线回放数据，只给引擎的 go test 用
  README.md  PROVENANCE.md  LICENSE
release.sh              # 按 plugins.json 逐个打 zip 并上传 Release
```

新增插件 = 新增 `plugins/<id>/` + 在 `plugins.json` 里加一条。

## 开发

插件跟着引擎一起测：把本仓库的插件目录链进引擎的 `plugins/`，跑真实的 moejs 运行时 +
`rule.mjs` 回放 fixture：

```bash
git clone https://github.com/abigmiu/parse.git
cd parse && ./scripts/dev-plugins.sh   # 默认链接 ../parse-plugins/plugins/<id>
cd engine && go test ./internal/ruletests/...
```

工程约定（`RuleResult`、`ctx`、错误码、WASM ABI）见引擎仓库的
[docs/plugins.md](https://github.com/abigmiu/parse/blob/main/docs/plugins.md)。

## 许可

插件本身 MIT（见各目录 `LICENSE`）。改编自上游的部分见各自的 `PROVENANCE.md`：
抖音 / 小红书 / B 站 / X 改编自 [hotier/MediaGet](https://github.com/hotier/MediaGet)（MIT），
知乎改编自 [frostming/fxzhihu](https://github.com/frostming/fxzhihu)（MIT）。
