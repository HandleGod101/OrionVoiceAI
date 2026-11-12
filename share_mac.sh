#!/usr/bin/env bash
set -euo pipefail

cloudflared_bin="$(command -v cloudflared || true)"
if [[ -z "$cloudflared_bin" ]]; then
  for candidate in /opt/homebrew/bin/cloudflared /usr/local/bin/cloudflared; do
    if [[ -x "$candidate" ]]; then
      cloudflared_bin="$candidate"
      break
    fi
  done
fi
if [[ -z "$cloudflared_bin" ]]; then
  echo "cloudflared was not found. Install it with: brew install cloudflared"
  echo "Then run: bash share_mac.sh"
  exit 1
fi
if ! curl --fail --silent --output /dev/null --max-time 5 http://127.0.0.1:8000/api/health; then
  echo "Orion is not responding on port 8000. Start it in another terminal:"
  echo "python -m uvicorn app:app --host 127.0.0.1 --port 8000"
  exit 1
fi
printf '%s\n' "Copy the https://...trycloudflare.com link from the output below." \
  "Keep this terminal and the app running. Press Ctrl+C to stop sharing."
exec "$cloudflared_bin" tunnel --url http://127.0.0.1:8000
