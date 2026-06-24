#!/usr/bin/env bash
# 探测 mori 守护进程所处状态，供「按状态上线」决策。
# 用法： bash detect-env.sh <仓库绝对路径>
# 输出： LAUNCH=<启动命令>，status 原文，以及 STATE=A_not_installed|B_stopped|C_running|unknown
set -euo pipefail
REPO="${1:-}"

if command -v mori >/dev/null 2>&1; then
  LAUNCH="mori"
elif [ -n "$REPO" ] && [ -f "$REPO/dist/main.js" ]; then
  LAUNCH="node $REPO/dist/main.js"
else
  LAUNCH=""
fi

echo "LAUNCH=$LAUNCH"
if [ -z "$LAUNCH" ]; then
  echo "STATE=A_not_installed"
  exit 0
fi

set +e
OUT="$($LAUNCH status 2>&1)"
STATUS=$?
set -e
echo "$OUT"
if [ "$STATUS" -eq 0 ] && echo "$OUT" | grep -q "运行中"; then
  echo "STATE=C_running"
elif echo "$OUT" | grep -q "未运行"; then
  echo "STATE=B_stopped"
else
  echo "STATE=unknown"
fi
