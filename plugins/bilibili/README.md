# B 站 · self-parse 插件

哔哩哔哩视频/专栏解析。属于 [self-parse](https://github.com/abigmiu/parse) 的插件集合仓库
[parse-plugins](https://github.com/abigmiu/parse-plugins)（目录 `plugins/bilibili/`）。

## 支持的输入

- `https://www.bilibili.com/video/BV…`（含 `?p=` 分 P）
- `b23.tv` 短链
- 专栏 `https://www.bilibili.com/read/cv…`

## 安装

从 [Releases](https://github.com/abigmiu/parse-plugins/releases) 下载 `bilibili.zip`，
（`plugin.json` 在 zip 根目录，可直接上传安装；不要把整仓的 Download ZIP 拿来装）

```bash
curl -X POST http://127.0.0.1:8051/api/plugins/install \
  -H "X-Parse-Token: <你的令牌>" -H "Content-Type: application/zip" \
  --data-binary @bilibili.zip
```

也可以直接解压进引擎的插件目录（`PARSE_PLUGINS_DIR`）。

## 配置

| 键 | 类型 | 说明 |
|---|---|---|
| `cookie` | secret | 登录后从浏览器复制；只保存在本机 |

Cookie / 密钥用 `PUT /api/plugins/bilibili/config` 写入，只保存在本机
`data/plugins/bilibili/config.json`。

## 依赖

宿主原生能力：无

## 已知限制

- wbi 签名没有实现，部分接口可能因风控失败
- UP 主空间统计没有实现（有意省略）

## 来源与许可

见 [PROVENANCE.md](PROVENANCE.md)。本插件以 MIT 发布（[LICENSE](LICENSE)），上游著作权归原作者。
