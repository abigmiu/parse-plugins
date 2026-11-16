#!/usr/bin/env bash
# 按 plugins.json 逐个打 zip，产出 dist/<id>.zip（plugin.json 在 zip 根目录，
# 可直接上传 /api/plugins/install）。
#
#   ./release.sh              # 只打包
#   ./release.sh --upload     # 打包后上传到 GitHub Release（需要 gh 已登录）
#
# 版本号取 plugins.json 里的 version；tag 形如 plugins-2026.11.15。
set -euo pipefail

cd "$(dirname "$0")"
UPLOAD=0
[[ "${1:-}" == "--upload" ]] && UPLOAD=1

command -v zip >/dev/null || { echo "需要 zip 命令" >&2; exit 1; }
command -v python3 >/dev/null || { echo "需要 python3" >&2; exit 1; }

# fixtures 是测试数据，不进安装包。
rm -rf dist && mkdir -p dist

python3 - <<'PY' | while IFS=$'\t' read -r id dir; do
import json
for e in json.load(open('plugins.json')):
    print(f"{e['id']}\t{e['dir']}")
PY
  out="dist/$id.zip"
  ( cd "$dir" && zip -qr "$OLDPWD/$out" . -x 'fixtures/*' -x '.*' )
  echo "packed $out ($(du -h "$out" | cut -f1))"
done

TAG="plugins-$(date +%Y.%m.%d)"
if (( UPLOAD )); then
  command -v gh >/dev/null || { echo "需要 gh CLI" >&2; exit 1; }
  if gh release view "$TAG" >/dev/null 2>&1; then
    gh release upload "$TAG" dist/*.zip --clobber
  else
    gh release create "$TAG" dist/*.zip \
      --title "插件 $TAG" --notes "由 release.sh 打包：每个插件一个 zip，plugin.json 在根目录。"
  fi
  echo "==> 已发布 https://github.com/abigmiu/parse-plugins/releases/tag/$TAG"
else
  echo "==> dist/ 已就绪；加 --upload 上传到 Release $TAG"
fi
