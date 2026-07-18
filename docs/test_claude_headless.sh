#!/usr/bin/env bash
set -euo pipefail

claude -p \
  --system-prompt "You are Aria. Keep answers under 4 sentences." \
  --model claude-haiku-4-5-20251001 \
  --output-format json \
  --no-session-persistence \
  "hi, can you tell me about what time is?"
