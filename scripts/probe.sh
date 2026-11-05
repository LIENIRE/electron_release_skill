#!/usr/bin/env bash
# probe.sh —— 项目画像探测（跨平台包装层）
#
# 优先调用同目录的 probe.mjs；若不可用则回退到内置的纯 bash 探测（能力降级但可用）。
#
# 用法：
#   ./probe.sh [项目根目录]          # 人类可读输出
#   ./probe.sh . --json             # JSON 输出
#
# 退出码：0 识别为 Electron 项目 / 2 参数错 / 3 非 Electron 项目
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${1:-.}"
JSON=""
[ "${2:-}" = "--json" ] && JSON="--json"

# ---- 优先 Node 路径（信息最完整）----
if command -v node >/dev/null 2>&1 && [ -f "$DIR/probe.mjs" ]; then
  exec node "$DIR/probe.mjs" "$ROOT" $JSON
fi

# ---- 纯 bash 回退：够用的关键字段 ----
[ -f "$ROOT/package.json" ] || { echo "✗ 未找到 package.json：$ROOT" >&2; exit 2; }

node -e '' 2>/dev/null && HAVE_NODE=1 || HAVE_NODE=0

# 走到这里却还有 node，说明上面的 exec 没生效 —— probe.mjs 缺失。
# 必须显式失败：静默 exit 0 会被上层当成「探测通过」（SKILL.md §0 铁律 7 / §5.12）。
if [ "$HAVE_NODE" = "1" ]; then
  echo "✗ node 可用，但同目录缺少 probe.mjs：$DIR/probe.mjs" >&2
  echo "提示：确认 scripts/ 目录完整，或用 install.sh --copy 重新安装本 skill" >&2
  exit 2
fi

if [ "$HAVE_NODE" = "0" ]; then
  #无 node：用 grep/sed 提取，能力有限但能识别关键配置
  has_dep() { grep -q "\"$1\"" "$ROOT/package.json" && echo 1 || echo 0; }
  if [ "$(has_dep electron)" = "0" ] && [ "$(has_dep electron-builder)" = "0" ]; then
    echo "✗ 未识别为 Electron 项目（无 electron / electron-builder 依赖）" >&2
    echo "提示：安装 Node.js 后重跑可获得完整画像" >&2
    exit 3
  fi
  ver=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -1)
  pn=$(sed -n 's/.*"productName"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -1)
  aid=$(sed -n 's/.*"appId"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -1)
  identity=$(grep -o '"identity"[[:space:]]*:[[:space:]]*\(null\|false\|"[^"]*"\)' "$ROOT/package.json" | head -1 | sed 's/.*:[[:space:]]*//')
  echo "项目        (名称解析失败)  v${ver}"
  echo "根目录      $(cd "$ROOT" && pwd)"
  echo "产品名/ID   ${pn:-未声明}  /  ${aid:-未声明}"
  echo "打包工具    electron-builder（推测）"
  echo "mac 签名    ${identity:-未声明}"
  echo
  echo "⚠ 无 Node.js，以上为降级结果。安装 Node 16+ 后重跑 probe.mjs 可得完整画像"
  exit 0
fi