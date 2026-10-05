#!/bin/sh
set -eu
cd /workspace
node scripts/preview.mjs stop || true

# AIO API (Grok preview proxies /api and /health here)
if ! curl -sf -o /dev/null --max-time 2 http://127.0.0.1:8787/health; then
  node scripts/aio-api.mjs >>/tmp/aio-api.log 2>&1 &
fi

if curl -sf -o /dev/null --max-time 2 http://127.0.0.1:8080/; then
  exit 0
fi
npm run dev >>/tmp/app-startup.log 2>&1 &
