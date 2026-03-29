#!/bin/bash
# Refreshes cached credentials for launchd-triggered scripts.
# Run this manually whenever credentials change.
# Requires: op CLI with service account token available.

export OP_SERVICE_ACCOUNT_TOKEN=$(python3 -c "
import re, os
with open(os.path.expanduser('~/1password service.rtf')) as f:
    text = f.read()
token = re.search(r'(ops_[A-Za-z0-9+/=]+)', text)
print(token.group(1) if token else '')
")

if [ -z "$OP_SERVICE_ACCOUNT_TOKEN" ]; then
  echo "ERROR: Failed to extract OP service account token" >&2
  exit 1
fi

CREDS_FILE="$HOME/.config/job-hunt/creds.json"

SUPABASE_URL=$(op item get "Open Brain - Supabase" --vault ClawdBot --fields label=project_url --reveal)
SUPABASE_KEY=$(op item get "Open Brain - Supabase" --vault ClawdBot --fields label=service_role_key --reveal)
SLACK_TOKEN=$(op item get "Open Brain - Slack" --vault ClawdBot --fields label=credential --reveal)
SLACK_CHANNEL=$(op item get "Open Brain - Slack" --vault ClawdBot --fields label=channel --reveal)
GMAIL_EMAIL=$(op item get "Daniel Gmail SMTP" --vault ClawdBot --fields label=email --reveal)
GMAIL_APP_PASSWORD=$(op item get "Daniel Gmail SMTP" --vault ClawdBot --fields label=app_password --reveal)

python3 -c "
import json
creds = {
    'supabase_url': '$SUPABASE_URL',
    'supabase_key': '$SUPABASE_KEY',
    'slack_token': '$SLACK_TOKEN',
    'slack_channel': '$SLACK_CHANNEL',
    'gmail_email': '$GMAIL_EMAIL',
    'gmail_app_password': '$GMAIL_APP_PASSWORD',
}
with open('$CREDS_FILE', 'w') as f:
    json.dump(creds, f, indent=2)
print(f'Credentials cached to $CREDS_FILE')
"
chmod 600 "$CREDS_FILE"
