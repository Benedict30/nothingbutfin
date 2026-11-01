#!/bin/zsh
# Double-click to start the Financial Statements viewer (macOS).
cd "$(dirname "$0")" || exit 1

# Node from nvm / Homebrew, if the shell didn't load it
export NVM_DIR="$HOME/.nvm"
[ -z "$(command -v node)" ] && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
[ -z "$(command -v node)" ] && [ -x /opt/homebrew/bin/node ] && export PATH="/opt/homebrew/bin:$PATH"
if [ -z "$(command -v node)" ]; then
  echo "Node.js was not found. Install it from https://nodejs.org (v18 or newer), then double-click this file again."
  read -r "?Press Enter to close."
  exit 1
fi

# The SEC asks every caller to identify itself (name + email). Asked once, saved locally.
if [ -z "$SEC_USER_AGENT" ]; then
  if [ -s .sec-user-agent ]; then
    SEC_USER_AGENT="$(cat .sec-user-agent)"
  else
    echo "The SEC requires a contact in each request (it is only sent to sec.gov)."
    read -r "SEC_USER_AGENT?Your name and email, e.g. 'Jane Tan jane@example.com': "
    printf '%s' "$SEC_USER_AGENT" > .sec-user-agent
  fi
fi
export SEC_USER_AGENT
PORT="${PORT:-3000}"
export PORT

(sleep 1.5 && open "http://localhost:$PORT") &
echo "Starting on http://localhost:$PORT — close this window or press Ctrl+C to stop."
node server.js
