#!/usr/bin/env bash
# Lance l'editeur PDF en local.
cd "$(dirname "$0")"
PORT="${1:-8420}"
echo "Editeur PDF -> http://localhost:$PORT"
exec python3 -m uvicorn server:app --host 127.0.0.1 --port "$PORT" --log-level warning
