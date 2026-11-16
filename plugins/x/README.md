# X（推特） · self-parse 插件

X/Twitter 推文解析（视频/多图/长文/Article）。属于 [self-parse](https://github.com/abigmiu/parse) 的插件集合仓库
[parse-plugins](https://github.com/abigmiu/parse-plugins)（目录 `plugins/x/`）。

## 支持的输入

- 推文链接 `https://x.com/<user>/status/<id>`
- `twitter.com` 同构链接
- 含链接的整段文案

## 安装

从 [Releases](https://github.com/abigmiu/parse-plugins/releases) 下载 `x.zip`，
（`plugin.json` 在 zip 根目录，可直接上传安装；不要把整仓的 Download ZIP 拿来装）

```bash
curl -X POST http://127.0.0.1:8051/api/plugins/install \
  -H "X-Parse-Token: <你的令牌>" -H "Content-Type: application/zip" \
  --data-binary @x.zip
```

也可以直接解压进引擎的插件目录（`PARSE_PLUGINS_DIR`）。

## 配置

| 键 | 类型 | 说明 |
|---|---|---|
| `cookie` | secret | 登录后从浏览器复制；只保存在本机 |
| `twitterFixerServices` | string | 逗号分隔的第三方 fixer 域名，留空使用默认列表 |
| `twitterFixerRelayUrl` | string | 阅读器中继的 base URL；填写 off/none/false/0 可关闭 |
| `twitterGraphqlQueryId` | string | 可选；X 轮换 TweetResultByRestId 的 queryId 时无需改代码，留空使用内置值 |

Cookie / 密钥用 `PUT /api/plugins/x/config` 写入，只保存在本机
`data/plugins/x/config.json`。

## 依赖

宿主原生能力：无

## 已知限制

- 纯文字推文返回 `MEDIA_NOT_FOUND`（契约要求 media 或 content 非空）
- 尚无真实链接回归，仅 fixture 覆盖

## 来源与许可

见 [PROVENANCE.md](PROVENANCE.md)。本插件以 MIT 发布（[LICENSE](LICENSE)），上游著作权归原作者。
