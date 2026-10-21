#!/usr/bin/env bash
# dsh-soul installer for macOS / Linux.
# Usage: bash install.sh [profile-name]   (default: web)
set -euo pipefail

PROFILE="${1:-web}"
HERE="$(cd "$(dirname "$0")" && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"

if [ ! -d "$DSH_HOME/profiles" ]; then
  echo "找不到 DSH profiles 目录：$DSH_HOME/profiles（DSH 装了吗？）" >&2
  exit 1
fi
if [ ! -d "$PROFILE_DIR" ]; then
  echo "profile '$PROFILE' 不存在。可用：" >&2
  ls -1 "$DSH_HOME/profiles" >&2
  exit 1
fi

PKG="$PROFILE_DIR/package.json"
[ -f "$PKG" ] || { echo "找不到 $PKG" >&2; exit 1; }
[ -f "$PKG.bak-soul" ] || cp "$PKG" "$PKG.bak-soul"

# 优先用 node，没有就试 python3
if command -v node >/dev/null 2>&1; then
  node - "$PKG" "$HERE" <<'EOF'
const fs = require("fs");
const [pkgPath, here] = process.argv.slice(2);
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
pkg.dependencies = pkg.dependencies || {};
pkg.dependencies["dsh-soul"] = "file:" + here;
pkg.dsh = pkg.dsh || {};
pkg.dsh.profile = pkg.dsh.profile || {};
pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || [];
if (!pkg.dsh.profile.bundles.includes("dsh-soul")) pkg.dsh.profile.bundles.push("dsh-soul");
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
EOF
elif command -v python3 >/dev/null 2>&1; then
  python3 - "$PKG" "$HERE" <<'EOF'
import json, sys
pkg_path, here = sys.argv[1], sys.argv[2]
with open(pkg_path, encoding="utf-8") as f:
    pkg = json.load(f)
pkg.setdefault("dependencies", {})["dsh-soul"] = "file:" + here
pkg.setdefault("dsh", {}).setdefault("profile", {}).setdefault("bundles", [])
if "dsh-soul" not in pkg["dsh"]["profile"]["bundles"]:
    pkg["dsh"]["profile"]["bundles"].append("dsh-soul")
with open(pkg_path, "w", encoding="utf-8") as f:
    json.dump(pkg, f, ensure_ascii=False, indent=2)
    f.write("\n")
EOF
else
  echo "需要 node 或 python3 来改 package.json" >&2
  exit 1
fi

LINK="$PROFILE_DIR/node_modules/dsh-soul"
if [ ! -e "$LINK" ]; then
  mkdir -p "$PROFILE_DIR/node_modules"
  ln -s "$HERE" "$LINK"
fi

echo
echo "安装完成："
echo "  插件目录：$HERE"
echo "  已写入：$PKG（备份 $PKG.bak-soul）"
echo "  链接：$LINK"
echo
echo "现在重启 DSH，然后新建一个会话测试。"
