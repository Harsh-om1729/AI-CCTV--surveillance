#!/usr/bin/env bash
# Launch IBVAP from any working directory.
#   ./run.sh          # live OpenCV apps
#   ./run.sh dash     # Streamlit incident dashboard (fallback UI)
#   ./run.sh api      # FastAPI backend on :8000, serves /api/v1
#   ./run.sh web      # React dashboard on :5173 (needs ./run.sh api too)
#   ./run.sh up       # api + dashboard together, reachable on the LAN
#   ./run.sh all      # AI pipeline + api + dashboard: the complete system
#   ./run.sh camstop  # release the webcam the API is holding
#   ./run.sh app 0 rtsp://...   # extra args pass through to app.py
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -d "$SCRIPT_DIR/ibvap" ]]; then
  cd "$SCRIPT_DIR/ibvap"
else
  cd "$SCRIPT_DIR"
fi
source venv/bin/activate

case "${1:-app}" in
  dash|dashboard) exec streamlit run dashboard/streamlit_app.py ;;
  api)            exec uvicorn integration.api:app --host "${IBVAP_BIND:-127.0.0.1}" --port 8000 ;;
  # Frees the device for app.py. Close the dashboard's Live Feeds tab first,
  # or the browser reconnects and re-opens the camera straight away.
  camstop)        tok=$(grep '^VITE_API_TOKEN=' frontend/.env | cut -d= -f2)
                  for cam in $(curl -s -H "Authorization: Bearer $tok" \
                        http://127.0.0.1:8000/api/v1/cameras \
                        | sed -n 's/.*"id": *"\([^"]*\)".*/\1/p'); do
                    curl -s -X POST -H "Authorization: Bearer $tok" \
                      "http://127.0.0.1:8000/api/v1/cameras/$cam/stop"
                    echo
                  done
                  exit 0 ;;
  # npm lives outside the venv; cd so Vite finds frontend/package.json.
  web)            cd frontend
                  if [[ ! -d node_modules ]]; then npm install; fi
                  exec npm run dev -- --host ;;

  # The whole system. The pipeline runs in the foreground (it owns the video
  # window and the 'q'/'z' keys); api and dashboard run behind it and are
  # killed when it exits. The dashboard shows the pipeline's own annotated
  # frames, so the webcam is opened exactly once.
  all)            shift || true
                  lan=$(ipconfig getifaddr en0 2>/dev/null || echo 127.0.0.1)
                  export IBVAP_ALLOW_LAN=1
                  uvicorn integration.api:app --host 0.0.0.0 --port 8000 &
                  api_pid=$!
                  (cd frontend && { [[ -d node_modules ]] || npm install; } && npm run dev -- --host) &
                  web_pid=$!
                  trap 'kill $api_pid $web_pid 2>/dev/null' EXIT INT TERM
                  echo
                  echo "  Dashboard  http://$lan:5173   (this machine: http://localhost:5173)"
                  echo "  Press q in the video window to stop everything."
                  echo
                  python app.py "$@" ;;

  # Both halves in one command. The API goes to the background and is killed
  # with this script, so Ctrl+C leaves nothing holding the webcam or :8000.
  up)             lan=$(ipconfig getifaddr en0 2>/dev/null || echo 127.0.0.1)
                  export IBVAP_ALLOW_LAN=1 IBVAP_BIND=0.0.0.0
                  uvicorn integration.api:app --host 0.0.0.0 --port 8000 &
                  api_pid=$!
                  trap 'kill $api_pid 2>/dev/null' EXIT INT TERM
                  echo
                  echo "  API        http://$lan:8000/api/v1"
                  echo "  Dashboard  http://$lan:5173   <- open this"
                  echo "  (same machine: http://localhost:5173)"
                  echo
                  cd frontend
                  if [[ ! -d node_modules ]]; then npm install; fi
                  npm run dev -- --host ;;
  app)            shift || true; exec python app.py "$@" ;;
  *)              exec python app.py "$@" ;;
esac
