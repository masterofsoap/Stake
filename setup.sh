#!/usr/bin/env bash
# Builds ./mobile for store builds. Usage: API_URL=https://your-worker.workers.dev BUNDLE_ID=com.you.stake bash setup.sh
set -e
cd "$(dirname "$0")"
bash scripts/prepare-app.sh
echo "Done: ./mobile is ready. cd mobile && npx eas-cli build --platform all --profile production"
