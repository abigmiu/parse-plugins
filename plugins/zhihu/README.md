# 知乎 · self-parse 插件

知乎回答/问题/专栏/想法解析（正文 + 图片/视频）。属于 [self-parse](https://github.com/abigmiu/parse) 的插件集合仓库
[parse-plugins](https://github.com/abigmiu/parse-plugins)（目录 `plugins/zhihu/`）。

## 支持的输入

- 回答 `/question/<id>/answer/<id>`、`/answer/<id>`
- 问题 `/question/<id>`
- 专栏文章 `/p/<id>`
- 想法 `/pin/<id>`

## 安装

从 [Releases](https://github.com/abigmiu/parse-plugins/releases) 下载 `zhihu.zip`，
（`plugin.json` 在 zip 根目录，可直接上传安装；不要把整仓的 Download ZIP 拿来装）

```bash
curl -X POST http://127.0.0.1:8051/api/plugins/install \
  -H "X-Parse-Token: <你的令牌>" -H "Content-Type: application/zip" \
  --data-binary @zhihu.zip
```

也可以直接解压进引擎的插件目录（`PARSE_PLUGINS_DIR`）。

## 配置

| 键 | 类型 | 说明 |
|---|---|---|
| `cookie` | secret | 登录后从浏览器复制；回答需要 z_c0，专栏/问题需要 d_c0 参与 x-zse-96 签名；只保存在本机 |

Cookie / 密钥用 `PUT /api/plugins/zhihu/config` 写入，只保存在本机
`data/plugins/zhihu/config.json`。

## 依赖

宿主原生能力：无

## 已知限制

- 缺少 `z_c0` 时走匿名 Cookie 回退，可能被风控
- `/zvideo/` 交给 ytdlp 规则，`/column/` 不是单条内容，都不匹配本规则

## 来源与许可

见 [PROVENANCE.md](PROVENANCE.md)。本插件以 MIT 发布（[LICENSE](LICENSE)），上游著作权归原作者。
