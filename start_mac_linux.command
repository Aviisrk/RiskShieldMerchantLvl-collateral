#!/usr/bin/env bash
# Double-clickable launcher for macOS / Linux.
# Runs the Python server from this file's own folder, regardless of where it's launched.
cd "$(dirname "$0")" || exit 1
echo "Launching RiskShield Risk Desk..."
if command -v python3 >/dev/null 2>&1; then
  python3 run_riskshield.py
elif command -v python >/dev/null 2>&1; then
  python run_riskshield.py
else
  echo "Python 3 not found. Install it from https://www.python.org/downloads/ and try again."
  read -r -p "Press Enter to close..."
fi
