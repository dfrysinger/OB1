#!/bin/bash
# Wrapper for launchd-triggered scripts.
# Extracts the 1Password service account token and passes it to the Deno script.
# Usage: launchd-wrapper.sh <script.ts> [args...]

export OP_SERVICE_ACCOUNT_TOKEN=$(python3 -c "
import re
with open('$HOME/1password service.rtf') as f:
    text = f.read()
token = re.search(r'(ops_[A-Za-z0-9+/=]+)', text)
print(token.group(1) if token else '')
")

exec /opt/homebrew/bin/deno run --allow-all "$@"
