#!/usr/bin/env bash
# Deploy the app to its primary home, https://mothtrap.blue (the lltk.net box).
# See docs/DEPLOY.md for the server-side setup (nginx vhost, capped Ollama).
#
# NOTE: CI does this automatically on every push to main (deploy-blue job in
# .github/workflows/ci.yml). This script is for manual/emergency deploys only.
#
# Usage: scripts/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."

HOST=root@lltk.net
WEBROOT=/var/www/mothtrap
APP_URL=https://mothtrap.blue/

APP_URL=$APP_URL npm run gen:metadata
VITE_OAUTH_CLIENT_ID=${APP_URL}client-metadata.json npm run build

# The deploy config lives on the SERVER (it's per-deployment state, not a build
# artifact) — exclude it from --delete so a redeploy never wipes it.
rsync -az --delete \
  --exclude mothtrap.config.json \
  --exclude skynets.config.json \
  dist/ "$HOST:$WEBROOT/"

echo "deployed. smoke:"
curl -s -o /dev/null -w "  index:  %{http_code}\n" "$APP_URL"
curl -s -o /dev/null -w "  config: %{http_code}\n" "${APP_URL}mothtrap.config.json"
curl -s -o /dev/null -w "  ollama: %{http_code}\n" "${APP_URL}ollama/api/tags"
