#!/bin/bash
# Double-click this file to start Bandshell.
# It builds the app if needed, serves it, and opens it in your browser.
# Once you've installed it (see the note printed below) you can open Bandshell
# from your Dock instead and leave this alone.

cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js isn't installed — get it from https://nodejs.org and try again."
  echo
  read -r -p "Press return to close."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "First run — installing dependencies (this takes a minute)…"
  npm install || { echo "Install failed."; read -r -p "Press return to close."; exit 1; }
fi

# Rebuild when any source file is newer than the last build.
needs_build=0
if [ ! -f dist/index.html ]; then
  needs_build=1
elif [ -n "$(find src index.html vite.config.js package.json scripts -newer dist/index.html 2>/dev/null)" ]; then
  needs_build=1
fi

if [ "$needs_build" -eq 1 ]; then
  echo "Building Bandshell…"
  npm run build || { echo "Build failed."; read -r -p "Press return to close."; exit 1; }
fi

PORT=4173
echo
echo "  Bandshell is running at http://localhost:$PORT"
echo
echo "  To put it in your Dock: in Chrome, open the ⋮ menu →"
echo "  Cast, Save and Share → Install page as app."
echo "  After that it opens from the Dock and works offline —"
echo "  you won't need this window again."
echo
echo "  Close this window to stop the server."
echo

npx vite preview --port "$PORT" --strictPort --open
