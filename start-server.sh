#!/usr/bin/env bash
# Start Parley backend (loads nvm if npm is not on PATH)
cd "$(dirname "$0")"
if ! command -v npm >/dev/null 2>&1; then
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "npm not found. Install Node.js: https://nodejs.org or run: curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash"
  exit 1
fi
exec npm run server
