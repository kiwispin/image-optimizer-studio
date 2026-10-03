#!/bin/bash
# Image Optimizer Studio - macOS / Linux launcher.
# Double-click "Start Image Optimizer Studio.command" in Finder, or run: ./scripts/start-local.sh
# Written for the bash 3.2 that ships with macOS (no bash 4+ features).

set -u

PORT="${PORT:-4174}"
URL="http://127.0.0.1:${PORT}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

pause_and_exit() {
  echo
  read -r -p "Press Return to close this window." _ || true
  exit "${1:-1}"
}

open_browser() {
  if command -v open >/dev/null 2>&1; then
    open "$1"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$1" >/dev/null 2>&1 &
  else
    echo "Open $1 in your browser."
  fi
}

server_is_up() {
  curl -fsS --max-time 1 "${URL}/api/health" >/dev/null 2>&1
}

# --- Find Node.js -----------------------------------------------------------
# A double-clicked .command doesn't load ~/.zshrc, so Node installed through nvm or
# Homebrew is often not on PATH yet. Check the usual places.
find_node() {
  command -v node >/dev/null 2>&1 && return 0

  for dir in /opt/homebrew/bin /usr/local/bin "$HOME/.homebrew/bin" "$HOME/homebrew/bin"; do
    if [ -x "$dir/node" ]; then
      PATH="$dir:$PATH"
      export PATH
      return 0
    fi
  done

  NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    export NVM_DIR
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
    nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || true
    command -v node >/dev/null 2>&1 && return 0
  fi

  return 1
}

if server_is_up; then
  echo "Image Optimizer Studio is already running at ${URL}"
  open_browser "$URL"
  exit 0
fi

if ! find_node; then
  echo "Node.js is not installed (or could not be found)."
  echo
  echo "Install the LTS version from https://nodejs.org (the macOS installer is easiest),"
  echo "then double-click this launcher again."
  open_browser "https://nodejs.org/en/download"
  pause_and_exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Node.js $(node -v) is too old. Please install Node 20 or newer from https://nodejs.org"
  open_browser "https://nodejs.org/en/download"
  pause_and_exit 1
fi
echo "Using Node.js $(node -v)"

# --- Install / build when needed ---------------------------------------------
# Reinstall when package-lock.json changed since the last install (e.g. after a git pull).
if [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  echo "Installing dependencies (first run can take a minute)..."
  if ! npm install --no-audit --no-fund; then
    echo "npm install failed."
    pause_and_exit 1
  fi
fi

# Rebuild when the source is newer than the last build, so code updates actually take effect.
SERVER_ENTRY="dist/src/server/index.js"
needs_build=0
if [ ! -f "$SERVER_ENTRY" ] || [ ! -f dist/client/index.html ]; then
  needs_build=1
elif [ -n "$(find src index.html vite.config.ts tsconfig.json package-lock.json -newer "$SERVER_ENTRY" -print 2>/dev/null | head -n 1)" ]; then
  needs_build=1
fi
if [ "$needs_build" -eq 1 ]; then
  echo "Building the app..."
  if ! npm run build; then
    echo "Build failed."
    pause_and_exit 1
  fi
fi

# --- Start ----------------------------------------------------------------------
echo "Starting Image Optimizer Studio at ${URL}"
echo "Leave this window open while you use the app. Close it (or press Ctrl+C) to stop."
echo

# Local use: only listen on this computer, not the whole network.
HOST=127.0.0.1 PORT="$PORT" node "$SERVER_ENTRY" &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null; exit 0' INT TERM HUP

for _ in $(seq 1 60); do
  if server_is_up; then
    open_browser "$URL"
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "The server stopped unexpectedly (is something else using port ${PORT}?)."
    pause_and_exit 1
  fi
  sleep 0.5
done

wait "$SERVER_PID"
