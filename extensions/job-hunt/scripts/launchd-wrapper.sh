#!/bin/bash
# Wrapper for launchd-triggered scripts.
# Reads credentials from a cached file (refreshed by the refresh-creds script).
# Usage: launchd-wrapper.sh <script.ts> [args...]

CREDS_FILE="$HOME/.config/job-hunt/creds.json"

if [ ! -f "$CREDS_FILE" ]; then
  echo "ERROR: $CREDS_FILE not found. Run refresh-creds.ts first." >&2
  exit 1
fi

export SUPABASE_URL=$(python3 -c "import json; print(json.load(open('$CREDS_FILE'))['supabase_url'])")
export SUPABASE_SERVICE_ROLE_KEY=$(python3 -c "import json; print(json.load(open('$CREDS_FILE'))['supabase_key'])")
export SLACK_BOT_TOKEN=$(python3 -c "import json; print(json.load(open('$CREDS_FILE'))['slack_token'])")
export SLACK_CHANNEL=$(python3 -c "import json; print(json.load(open('$CREDS_FILE'))['slack_channel'])")
export GMAIL_EMAIL=$(python3 -c "import json; print(json.load(open('$CREDS_FILE'))['gmail_email'])")
export GMAIL_APP_PASSWORD=$(python3 -c "import json; print(json.load(open('$CREDS_FILE'))['gmail_app_password'])")

exec /opt/homebrew/bin/deno run --allow-all "$@"
