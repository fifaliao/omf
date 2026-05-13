#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────
#  omf (oh-my-fallback) — install / update script
# ─────────────────────────────────────────────────────────────
# Usage:
#   ./install.sh              # dry-run (preview only)
#   ./install.sh --apply      # apply changes
#   ./install.sh --help       # this message
# ─────────────────────────────────────────────────────────────

OMF_SRC="$(cd "$(dirname "$0")" && pwd)"
CONFIG_DIR="${HOME}/.config/opencode"
CONFIG_FILE="${CONFIG_DIR}/opencode.json"
OMF_CONFIG="${CONFIG_DIR}/omf.json"

echo "== omf installer =="
echo "  Source:      ${OMF_SRC}"
echo "  Config dir:  ${CONFIG_DIR}"
echo ""

# ── 1. Ensure config directory exists ────────────────────────
mkdir -p "${CONFIG_DIR}"

# ── 2. Create default omf.json if absent ─────────────────────
if [ ! -f "${OMF_CONFIG}" ]; then
  echo "  [CREATE] ${OMF_CONFIG}"
  if [ "${1:-}" = "--apply" ]; then
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
#     We add a file:// reference for the local plugin directory.
PLUGIN_ENTRY="file://${OMF_SRC}"

if [ ! -f "${CONFIG_FILE}" ]; then
  echo "  [WARN]  ${CONFIG_FILE} not found — create it manually with:"
  echo '          { "plugin": ["'"${PLUGIN_ENTRY}"'"] }'
else
  # Check if already present
  if grep -qF "${PLUGIN_ENTRY}" "${CONFIG_FILE}" 2>/dev/null; then
    echo "  [OK]     Plugin already registered in opencode.json"
  else
    echo "  [EDIT]   Add to plugin array in ${CONFIG_FILE}:"
    echo "           \"${PLUGIN_ENTRY}\""
    if [ "${1:-}" = "--apply" ]; then
      # Use temporary file to insert plugin entry before the last entry
      TMP=$(mktemp)
      # Insert plugin entry as second-to-last element (before the closing bracket)
      # Works for simple arrays - assumes plugin is last array in the file
      awk -v entry="\"${PLUGIN_ENTRY}\"" '
        /\]/ && !done {
          # Ensure no trailing comma issues
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
if [ "${1:-}" = "--apply" ]; then
  echo "== Install complete. Restart OpenCode for changes to take effect. =="
else
  echo "== Dry-run complete. Run with --apply to make changes. =="
fi
