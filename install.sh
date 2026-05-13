#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────
#  omf (oh-my-fallback) — install / update script
# ─────────────────────────────────────────────────────────────
# Usage:
#   Local:  ./install.sh              # dry-run (preview only)
#           ./install.sh --apply      # apply changes
#
#   Online: curl -fsSL https://raw.githubusercontent.com/fifaliao/omf/main/install.sh | bash              # dry-run
#           curl -fsSL https://raw.githubusercontent.com/fifaliao/omf/main/install.sh | bash -s -- --apply # apply
#
# Options:
#   --apply       Apply changes (default: dry-run)
#   --repo=<url>  Git repo URL for online install (default: origin remote)
#   --help        Show this message
# ─────────────────────────────────────────────────────────────

# ── Parse args ───────────────────────────────────────────────
APPLY=false
CUSTOM_REPO=""
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=true ;;
    --repo=*) CUSTOM_REPO="${arg#*=}" ;;
    --help)
      sed -n '/^# ──.*Usage/,/^# ──/p' "$0" | grep '^# ' | sed 's/^# //'
      exit 0
      ;;
  esac
done

# ── Detect mode (local checkout vs online/piped) ─────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)"
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/index.js" ]; then
  LOCAL_MODE=true
  OMF_SRC="$SCRIPT_DIR"
else
  LOCAL_MODE=false
fi

CONFIG_DIR="${HOME}/.config/opencode"
CONFIG_FILE="${CONFIG_DIR}/opencode.json"
OMF_CONFIG="${CONFIG_DIR}/omf.json"
PLUGIN_DIR="${CONFIG_DIR}/plugins/omf"

# Determine repo URL: use --repo flag, then origin remote, then default
if $LOCAL_MODE; then
  REPO_URL="${CUSTOM_REPO:-$(git -C "$OMF_SRC" config --get remote.origin.url 2>/dev/null || true)}"
fi
REPO_URL="${REPO_URL:-https://github.com/fifaliao/omf.git}"

echo "== omf installer =="
echo "  Source:      ${OMF_SRC:-"(to be cloned)"}"
echo "  Mode:        $($LOCAL_MODE && echo "local" || echo "online")"
echo "  Config dir:  ${CONFIG_DIR}"

if ! $LOCAL_MODE; then
  echo "  Repo:        ${REPO_URL}"
  echo "  Plugins dir: ${PLUGIN_DIR}"
fi
echo ""

# ── Online mode: clone or update repo ───────────────────────
if ! $LOCAL_MODE; then
  if [ -d "$PLUGIN_DIR" ]; then
    echo "  [UPDATE] Fetching latest omf..."
    if $APPLY; then
      git -C "$PLUGIN_DIR" pull --ff-only --depth 1 origin main 2>/dev/null \
        || git -C "$PLUGIN_DIR" pull --ff-only --depth 1 origin master 2>/dev/null \
        || echo "  [WARN]  Update failed — try removing ${PLUGIN_DIR} and re-running"
    else
      echo "  [DRY-RUN] Would update ${PLUGIN_DIR}"
    fi
  else
    echo "  [CLONE]  Cloning omf from ${REPO_URL}..."
    if $APPLY; then
      mkdir -p "${CONFIG_DIR}/plugins"
      git clone --depth 1 "${REPO_URL}" "$PLUGIN_DIR"
    else
      echo "  [DRY-RUN] Would clone to ${PLUGIN_DIR}"
    fi
  fi
  OMF_SRC="$PLUGIN_DIR"
fi

# ── 1. Ensure config directory exists ────────────────────────
mkdir -p "${CONFIG_DIR}"

# ── 2. Create default omf.json if absent ─────────────────────
if [ ! -f "${OMF_CONFIG}" ]; then
  echo "  [CREATE] ${OMF_CONFIG}"
  if $APPLY; then
    cat > "${OMF_CONFIG}" << 'OMF_JSON'
{
  "fallback_models": {
    "default": [
      "opencode/big-pickle",
      "axon/gpt-5.4",
      "axon/claude-sonnet",
      "axon/deepseek"
    ],
    "agents": {}
  },
  "options": {
    "max_retries": 3,
    "cooldown_seconds": 30,
    "retry_on_errors": [429, 500, 502, 503, 504],
    "notify_on_fallback": true
  }
}
OMF_JSON
  fi
else
  echo "  [EXISTS]  ${OMF_CONFIG}"
fi

# ── 3. Add plugin entry to opencode.json ─────────────────────
PLUGIN_ENTRY="file://${OMF_SRC}"

if [ ! -f "${CONFIG_FILE}" ]; then
  echo "  [WARN]  ${CONFIG_FILE} not found — create it manually with:"
  echo '          { "plugin": ["'"${PLUGIN_ENTRY}"'"] }'
else
  if grep -qF "${PLUGIN_ENTRY}" "${CONFIG_FILE}" 2>/dev/null; then
    echo "  [OK]     Plugin already registered in opencode.json"
  else
    echo "  [EDIT]   Add to plugin array in ${CONFIG_FILE}:"
    echo "           \"${PLUGIN_ENTRY}\""
    if $APPLY; then
      TMP=$(mktemp)
      awk -v entry="\"${PLUGIN_ENTRY}\"" '
        /\]/ && !done {
          sub(/\],$/, ",")
          print "    " entry ","
          print "  ]"
          done=1
          next
        }
        { print }
      ' "${CONFIG_FILE}" > "${TMP}" && mv "${TMP}" "${CONFIG_FILE}"
      echo "  [DONE]   Plugin entry added to opencode.json"
    fi
  fi
fi

echo ""
if $APPLY; then
  echo "== Install complete. Restart OpenCode for changes to take effect. =="
else
  echo "== Dry-run complete. Run with --apply to make changes. =="
fi
