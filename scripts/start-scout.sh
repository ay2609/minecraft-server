#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ ! -f ".env" ]]; then
  echo "Missing .env. Copy .env.example to .env and configure it first."
  exit 1
fi

set -a
# shellcheck disable=SC1091
source ".env"
set +a

if ! command -v bun >/dev/null 2>&1; then
  if [[ -f "$HOME/.bashrc" ]]; then
    # shellcheck disable=SC1090
    source "$HOME/.bashrc"
  fi
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "bun was not found in PATH."
  exit 1
fi

runtime_pid=""
brain_pid=""

cleanup() {
  if [[ -n "${brain_pid:-}" ]] && kill -0 "$brain_pid" >/dev/null 2>&1; then
    kill "$brain_pid" >/dev/null 2>&1 || true
  fi
  if [[ -n "${runtime_pid:-}" ]] && kill -0 "$runtime_pid" >/dev/null 2>&1; then
    kill "$runtime_pid" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT INT TERM

export BOT_NAME="${BOT_NAME:-Scout}"
export MC_HOST="${MC_HOST:-127.0.0.1}"
export MC_PORT="${MC_PORT:-25565}"
export MC_USERNAME="${MC_USERNAME:-$BOT_NAME}"
export MC_AUTH="${MC_AUTH:-offline}"
export RUNTIME_WS_HOST="${RUNTIME_WS_HOST:-0.0.0.0}"
export RUNTIME_WS_PORT="${RUNTIME_WS_PORT:-8787}"
export SNAPSHOT_INTERVAL_MS="${SNAPSHOT_INTERVAL_MS:-1000}"
export SALIENCE_MIN="${SALIENCE_MIN:-0.15}"
export ENTITY_MOVE_MIN_INTERVAL_MS="${ENTITY_MOVE_MIN_INTERVAL_MS:-700}"
export INVENTORY_COALESCE_MS="${INVENTORY_COALESCE_MS:-500}"
export DANGER_RADIUS="${DANGER_RADIUS:-8}"
export ACTION_TIMEOUT_MS="${ACTION_TIMEOUT_MS:-15000}"
export IDLE_BEHAVIOR="${IDLE_BEHAVIOR:-standby}"
export REPEATED_FAILURE_WINDOW_MS="${REPEATED_FAILURE_WINDOW_MS:-60000}"
export REPEATED_FAILURE_THRESHOLD="${REPEATED_FAILURE_THRESHOLD:-3}"

export BRAIN_RUNTIME_WS_URL="${BRAIN_RUNTIME_WS_URL:-ws://127.0.0.1:8787}"
export THINKING_CADENCE_MS="${THINKING_CADENCE_MS:-5000}"
export THINKING_MIN_GAP_MS="${THINKING_MIN_GAP_MS:-1500}"
export REACTIVE_CADENCE_MS="${REACTIVE_CADENCE_MS:-1200}"
export LLM_PROVIDER="${LLM_PROVIDER:-openai}"
export OPENAI_BASE_URL="${OPENAI_BASE_URL}"
export OPENAI_MODEL="${OPENAI_MODEL}"

echo "Starting Scout runtime..."
bun run runtime &
runtime_pid="$!"

sleep 2
if ! kill -0 "$runtime_pid" >/dev/null 2>&1; then
  echo "Runtime exited early."
  exit 1
fi

echo "Starting Scout brain..."
bun run brain &
brain_pid="$!"

sleep 2
if ! kill -0 "$brain_pid" >/dev/null 2>&1; then
  echo "Brain exited early."
  exit 1
fi

echo "Scout is online. Press Ctrl+C to stop both."
wait "$runtime_pid" "$brain_pid"
