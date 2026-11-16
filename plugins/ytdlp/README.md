# yt-dlp（通用兜底） · self-parse 插件

调用宿主 yt-dlp 能力的通用兜底规则。属于 [self-parse](https://github.com/abigmiu/parse) 的插件集合仓库
[parse-plugins](https://github.com/abigmiu/parse-plugins)（目录 `plugins/ytdlp/`）。

## 支持的输入

- 任何 `http(s)` 链接（平台规则都不匹配时）

## 安装

从 [Releases](https://github.com/abigmiu/parse-plugins/releases) 下载 `ytdlp.zip`，
（`plugin.json` 在 zip 根目录，可直接上传安装；不要把整仓的 Download ZIP 拿来装）

```bash
curl -X POST http://127.0.0.1:8051/api/plugins/install \
  -H "X-Parse-Token: <你的令牌>" -H "Content-Type: application/zip" \
  --data-binary @ytdlp.zip
```

也可以直接解压进引擎的插件目录（`PARSE_PLUGINS_DIR`）。

## 配置

| 键 | 类型 | 说明 |
|---|---|---|
| — | — | 无配置项 |

Cookie / 密钥用 `PUT /api/plugins/ytdlp/config` 写入，只保存在本机
`data/plugins/ytdlp/config.json`。

## 依赖

宿主原生能力：`ytdlp`

## 已知限制

- 只返回音视频合一的直链；分离音视频流需要 ffmpeg 合流，当前返回 `MEDIA_NOT_FOUND`
- 不下载、不起进程：下载交给宿主，宿主会用 yt-dlp 自己选格式并合流
- 依赖本机安装 yt-dlp，缺失时插件不加载

## 来源与许可

见 [PROVENANCE.md](PROVENANCE.md)。本插件以 MIT 发布（[LICENSE](LICENSE)），上游著作权归原作者。
