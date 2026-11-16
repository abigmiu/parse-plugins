# 抖音 · self-parse 插件

抖音分享链接解析（视频/图文）。属于 [self-parse](https://github.com/abigmiu/parse) 的插件集合仓库
[parse-plugins](https://github.com/abigmiu/parse-plugins)（目录 `plugins/douyin/`）。

## 支持的输入

- 分享链接 `https://v.douyin.com/…`
- 作品链接 `https://www.douyin.com/video/<id>`
- 含链接的整段分享文案

## 安装

从 [Releases](https://github.com/abigmiu/parse-plugins/releases) 下载 `douyin.zip`，
（`plugin.json` 在 zip 根目录，可直接上传安装；不要把整仓的 Download ZIP 拿来装）

```bash
curl -X POST http://127.0.0.1:8051/api/plugins/install \
  -H "X-Parse-Token: <你的令牌>" -H "Content-Type: application/zip" \
  --data-binary @douyin.zip
```

也可以直接解压进引擎的插件目录（`PARSE_PLUGINS_DIR`）。

## 配置

| 键 | 类型 | 说明 |
|---|---|---|
| `cookie` | secret | 登录后从浏览器复制；只保存在本机 |

Cookie / 密钥用 `PUT /api/plugins/douyin/config` 写入，只保存在本机
`data/plugins/douyin/config.json`。

## 依赖

宿主原生能力：无

## 已知限制

- 分享页链路被风控时需要 Cookie
- DoH 直连、第三方解析服务兜底、博主统计没有实现（有意省略）

## 来源与许可

见 [PROVENANCE.md](PROVENANCE.md)。本插件以 MIT 发布（[LICENSE](LICENSE)），上游著作权归原作者。
