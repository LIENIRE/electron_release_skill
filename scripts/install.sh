#!/usr/bin/env bash
# install.sh —— 把本 skill 安装/链接到各 AI agent 的技能目录
#
# 用法：
#   ./install.sh# 自动探测本机已装的 agent 并全部链接
#   ./install.sh --link claude codex      # 只链接指定 agent
#   ./install.sh --copy                   # 用复制而非软链（Windows/跨机场景）
#   ./install.sh --list                   # 只显示本机支持的 agent 与检测状态
#   ./install.sh --all                    # 链接到所有支持的位置（不管是否已安装）
#
# 设计原则：**一份文件，多处引用**。默认用软链，避免各agent 副本各自漂移。

set -uo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="$(basename "$SRC")"
MODE="link"
TARGETS=()

# agent id | 全局目录 | 项目级目录 | 显示名
AGENTS=(
  "agents|$HOME/.agents/skills|通用 agents 规范"
  "claude|$HOME/.claude/skills|Claude Code"
  "codex|$HOME/.codex/skills|Codex"
  "cursor|$HOME/.cursor/skills|Cursor"
  "windsurf|$HOME/.codeium/windsurf/skills|Windsurf"
  "gemini|$HOME/.gemini/skills|Gemini CLI"
  "copilot|$HOME/.config/github-copilot/skills|GitHub Copilot CLI"
)

usage(){ sed -n '2,14p' "$0" | sed 's/^# \?//'; exit 0; }

while [ $# -gt 0 ]; do
  case "$1" in
    --link) MODE="link"; shift;;
    --copy) MODE="copy"; shift;;
    --all)  TARGETS=(); for a in "${AGENTS[@]}"; do TARGETS+=("${a%%|*}"); done; shift;;
    --list) TARGETS=("__list__"); shift;;
    -h|--help) usage;;
    -*) echo "未知参数: $1" >&2; usage;;
    *)  TARGETS+=("$1"); shift;;
  esac
done

# ---- --list ----
if [ "${TARGETS[0]:-}" = "__list__" ]; then
  echo "支持的位置与本机检测结果："
  printf '  %-10s %-42s %s\n' "ID" "路径" "状态"
  for a in "${AGENTS[@]}"; do
    id="${a%%|*}"; rest="${a#*|}"; dir="${rest%%|*}"; label="${rest##*|}"
    [ -d "$dir" ] && state="✓ 目录存在" || state="· 未创建（可装）"
    printf '  %-10s %-42s %s\n' "$id" "$dir" "$state"
    printf '  %-10s %-42s   %s\n' "" "" "$label"
  done
  exit 0
fi

[ -f "$SRC/SKILL.md" ] || { echo "✗ 找不到 $SRC/SKILL.md，目录不对" >&2; exit 2; }
[ ${#TARGETS[@]} -eq 0 ] && for a in "${AGENTS[@]}"; do
  id="${a%%|*}"; dir="$(echo "$a" | cut -d'|' -f2)"
  [ -d "$dir" ] && TARGETS+=("$id")
done

install_one(){
  local id="$1" path="$2"
  mkdir -p "$(dirname "$path")"
  if [ -e "$path" ] || [ -L "$path" ]; then
    if [ -L "$path" ]; then
      local cur; cur="$(readlink "$path")"
      if [ "$cur" = "$SRC" ]; then echo "  ✓ $id 已是链接，跳过"; return 0; fi
      ln -sfn "$SRC" "$path"; echo "  ↻ $id 更新链接 → $SRC"; return 0
    fi
    local bak="${path}.bak.$(date +%Y%m%d%H%M%S)"
    mv "$path" "$bak"; echo "  ! $id 已存在非链接，备份为 $(basename "$bak")"
  fi
  if [ "$MODE" = "copy" ]; then
    cp -R "$SRC" "$path"; echo "  + $id 已复制 → $path"
  else
    ln -s "$SRC" "$path"; echo "  + $id 已链接 → $path"
  fi
}

echo "源目录：$SRC"
echo "模式：$MODE"
echo "目标："
for id in "${TARGETS[@]}"; do
  row=""
  for a in "${AGENTS[@]}"; do
    [ "${a%%|*}" = "$id" ] && row="$a" && break
  done
  [ -z "$row" ] && { echo "  ? 未知 agent: $id（用 --list 查看支持项）"; continue; }
  dir="$(echo "$row" | cut -d'|' -f2)"
  label="$(echo "$row" | cut -d'|' -f3)"
  install_one "$id" "$dir/$NAME"
done
echo
echo "完成。验证：<目标目录>/$NAME/SKILL.md 是否存在"
echo "提示：项目级安装可把整个 skill 目录放进仓库的 .agents/skills/ 或 .claude/skills/，随仓库分发"