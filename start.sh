#!/usr/bin/env bash
# Runs the runner without Docker (WSL2 or Linux). Reads .env from this folder if present.
set -euo pipefail
cd "$(dirname "$0")"

fail() { echo "오류: $*" >&2; exit 1; }

command -v node >/dev/null || fail "Node.js가 없습니다. Node 22.13 이상을 설치하세요."
# node:sqlite works without a flag from 22.13.
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' \
  || fail "Node $(node -v)은 지원하지 않습니다. 22.13 이상이 필요합니다."

missing=()
for cmd in git claude codex notion-mcp-server; do command -v "$cmd" >/dev/null || missing+=("$cmd"); done
if ((${#missing[@]})); then
  echo "경고: 다음 명령이 없어 일부 기능이 동작하지 않습니다: ${missing[*]}" >&2
  echo "      npm install -g @anthropic-ai/claude-code @openai/codex @notionhq/notion-mcp-server" >&2
fi

[[ -f .env ]] || echo "안내: .env가 없어 NOTION_TOKEN 없이 실행합니다(노션 링크 업무는 거부됩니다)." >&2

exec node --env-file-if-exists=.env server.js
