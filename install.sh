#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────
#  omf (oh-my-fallback) — install / update script
# ─────────────────────────────────────────────────────────────
# Usage:
#   Local:  ./install.sh              # dry-run (preview only)
#           ./install.sh --apply      # apply changes
#           ./install.sh --configure  # interactive configuration
#
#   Online: curl -fsSL https://raw.githubusercontent.com/fifaliao/omf/main/install.sh | bash              # dry-run
#           curl -fsSL https://raw.githubusercontent.com/fifaliao/omf/main/install.sh | bash -s -- --apply # apply
#
# Options:
#   --apply       Apply changes (default: dry-run)
#   --configure   Interactive model selection and config
#   --repo=<url>  Git repo URL for online install (default: origin remote)
#   --help        Show this message
# ─────────────────────────────────────────────────────────────

# ── Colors ───────────────────────────────────────────────────
C_RESET='\033[0m'
C_GREEN='\033[0;32m'
C_RED='\033[0;31m'
C_YELLOW='\033[0;33m'
C_CYAN='\033[0;36m'
C_BOLD='\033[1m'

# ── Parse args ───────────────────────────────────────────────
APPLY=false
CONFIGURE=false
CUSTOM_REPO=""
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=true ;;
    --configure) CONFIGURE=true ;;
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

# ── Cross-platform config directory ─────────────────────────
# Windows: %APPDATA%\opencode\
# Linux/macOS: $XDG_CONFIG_HOME/opencode or ~/.config/opencode
detect_config_dir() {
  if [ -n "${APPDATA:-}" ]; then
    echo "${APPDATA}/opencode"
  elif [ -n "${XDG_CONFIG_HOME:-}" ]; then
    echo "${XDG_CONFIG_HOME}/opencode"
  else
    echo "${HOME}/.config/opencode"
  fi
}

CONFIG_DIR="$(detect_config_dir)"
CONFIG_FILE="${CONFIG_DIR}/opencode.json"
OMF_CONFIG="${CONFIG_DIR}/omf.json"
OH_MY_OPENAGENT="${CONFIG_DIR}/oh-my-openagent.json"
PLUGIN_DIR="${CONFIG_DIR}/plugins/omf"

# Determine repo URL: use --repo flag, then origin remote, then default
if $LOCAL_MODE; then
  REPO_URL="${CUSTOM_REPO:-$(git -C "$OMF_SRC" config --get remote.origin.url 2>/dev/null || true)}"
fi
REPO_URL="${REPO_URL:-https://github.com/fifaliao/omf.git}"

# ── Check jq availability ─────────────────────────────────────
has_jq() {
  command -v jq >/dev/null 2>&1
}

# ── Check if running interactively ──────────────────────────
is_tty() {
  [ -t 0 ] && [ -t 1 ]
}

# ─────────────────────────────────────────────────────────────
#  Model Capability Ranking Database
# ─────────────────────────────────────────────────────────────

# Model tiers for auto-generation
declare -A MODEL_TIERS
MODEL_TIERS[claude-opus]="premium"
MODEL_TIERS[claude-opus-4]="premium"
MODEL_TIERS[gpt-5]="premium"
MODEL_TIERS[gpt-5.4]="premium"
MODEL_TIERS[gemini-ultra]="premium"
MODEL_TIERS[claude-sonnet-4]="premium"
MODEL_TIERS[big-pickle]="premium"
MODEL_TIERS[claude-sonnet]="balanced"
MODEL_TIERS[claude-sonnet-3]="balanced"
MODEL_TIERS[gpt-4]="balanced"
MODEL_TIERS[gpt-4o]="balanced"
MODEL_TIERS[gpt-4-turbo]="balanced"
MODEL_TIERS[gemini-pro]="balanced"
MODEL_TIERS[deepseek-v3]="balanced"
MODEL_TIERS[deepseek-r1]="balanced"
MODEL_TIERS[claude-haiku]="fast"
MODEL_TIERS[claude-haiku-3]="fast"
MODEL_TIERS[gpt-4-mini]="fast"
MODEL_TIERS[gpt-4.1-nano]="fast"
MODEL_TIERS[gemini-flash]="fast"
MODEL_TIERS[deepseek-chat]="fast"
MODEL_TIERS[gpt-3.5]="cheap"
MODEL_TIERS[gpt-3.5-turbo]="cheap"
MODEL_TIERS[mixtral]="cheap"
MODEL_TIERS[llama]="cheap"
MODEL_TIERS[deepseek-coder]="cheap"

TIER_ORDER="premium balanced fast cheap"

get_model_tier() {
  local model_id="$1"
  local tier

  for tier in $TIER_ORDER; do
    for key in "${!MODEL_TIERS[@]}"; do
      if [ "${MODEL_TIERS[$key]}" = "$tier" ] && [[ "$model_id" == *"$key"* ]]; then
        echo "$tier"
        return 0
      fi
    done
  done

  echo "unknown"
  return 1
}

# ─────────────────────────────────────────────────────────────
#  Provider Discovery
# ─────────────────────────────────────────────────────────────

discover_providers() {
  local -n PROVIDERS="$1"
  PROVIDERS=()

  # Default provider base URLs
  PROVIDERS["opencode"]="https://opencode.ai"
  PROVIDERS["openai"]="https://api.openai.com"
  PROVIDERS["anthropic"]="https://api.anthropic.com"
  PROVIDERS["google"]="https://generativelanguage.googleapis.com"
  PROVIDERS["deepseek"]="https://api.deepseek.com"
  PROVIDERS["groq"]="https://api.groq.com"
  PROVIDERS["azure"]="https://.openai.azure.com"
  PROVIDERS["axon"]="https://api.axon.io"

  if [ -f "$CONFIG_FILE" ]; then
    if has_jq; then
      local provider_keys
      provider_keys=$(jq -r 'to_entries[] | "\(.key)|\(.value.baseURL // .value.endpoint // "")"' "$CONFIG_FILE" 2>/dev/null | grep -v "^|")
      while IFS='|' read -r key url; do
        if [ -n "$url" ]; then
          PROVIDERS["$key"]="$url"
        fi
      done <<< "$provider_keys"
    else
      while IFS= read -r line; do
        if echo "$line" | grep -qE '"(baseURL|endpoint|url)"'; then
          local key url
          key=$(echo "$line" | sed -n 's/.*"\([^"]*\)".*/\1/p')
          url=$(echo "$line" | sed -n 's/.*: *"\([^"]*\)".*/\1/p')
          if [ -n "$key" ] && [ -n "$url" ]; then
            PROVIDERS["$key"]="$url"
          fi
        fi
      done < "$CONFIG_FILE"
    fi
  fi

  # Environment variable API keys
  [ -n "${OPENAI_API_KEY:-}" ] && PROVIDERS["openai_key"]="$OPENAI_API_KEY"
  [ -n "${ANTHROPIC_API_KEY:-}" ] && PROVIDERS["anthropic_key"]="$ANTHROPIC_API_KEY"
  [ -n "${DEEPSEEK_API_KEY:-}" ] && PROVIDERS["deepseek_key"]="$DEEPSEEK_API_KEY"
  [ -n "${GROQ_API_KEY:-}" ] && PROVIDERS["groq_key"]="$GROQ_API_KEY"
  [ -n "${AZURE_API_KEY:-}" ] && PROVIDERS["azure_key"]="$AZURE_API_KEY"
  [ -n "${GEMINI_API_KEY:-}" ] && PROVIDERS["google_key"]="$GEMINI_API_KEY"
}

# ─────────────────────────────────────────────────────────────
#  Model Discovery
# ─────────────────────────────────────────────────────────────

discover_models() {
  local -n MODELS="$1"
  MODELS=()

  # Declare associative array for dedup
  declare -A SEEN

  # Parse JSON with jq or grep fallback
  if has_jq; then
    # From oh-my-openagent.json
    if [ -f "$OH_MY_OPENAGENT" ]; then
      local agents_models
      agents_models=$(jq -r '.agents[] | .model, (.fallback_models // [])[]' "$OH_MY_OPENAGENT" 2>/dev/null || true)
      while IFS= read -r model; do
        [ -n "$model" ] && [ -z "${SEEN[$model]:-}" ] && SEEN["$model"]=1 && MODELS+=("$model")
      done <<< "$agents_models"
    fi

    # From omf.json
    if [ -f "$OMF_CONFIG" ]; then
      local omf_default omf_agents
      omf_default=$(jq -r '.fallback_models.default[]' "$OMF_CONFIG" 2>/dev/null || true)
      omf_agents=$(jq -r '.fallback_models.agents[] | .[]' "$OMF_CONFIG" 2>/dev/null || true)
      while IFS= read -r model; do
        [ -n "$model" ] && [ -z "${SEEN[$model]:-}" ] && SEEN["$model"]=1 && MODELS+=("$model")
      done <<< "$omf_default"
      while IFS= read -r model; do
        [ -n "$model" ] && [ -z "${SEEN[$model]:-}" ] && SEEN["$model"]=1 && MODELS+=("$model")
      done <<< "$omf_agents"
    fi
  else
    # Fallback: grep/sed
    local files_to_scan="$OH_MY_OPENAGENT $OMF_CONFIG"
    for file in $files_to_scan; do
      [ -f "$file" ] || continue
      local matches
      matches=$(grep -oE '"[a-zA-Z0-9_/-]+/[a-zA-Z0-9._-]+"' "$file" 2>/dev/null | sed 's/"//g' || true)
      while IFS= read -r model; do
        [ -n "$model" ] && [ -z "${SEEN[$model]:-}" ] && SEEN["$model"]=1 && MODELS+=("$model")
      done <<< "$matches"
    done
  fi
}

# ─────────────────────────────────────────────────────────────
#  Model Testing
# ─────────────────────────────────────────────────────────────

test_model() {
  local model_str="$1"
  local -A PROVIDERS
  discover_providers PROVIDERS

  # Parse provider/model
  local provider="${model_str%%/*}"
  local model_id="${model_str#*/}"

  # Get base URL
  local base_url="${PROVIDERS[$provider]:-}"
  if [ -z "$base_url" ]; then
    echo "SKIP"
    return 0
  fi

  # Get API key
  local api_key="${PROVIDERS[${provider}_key]:-}"
  if [ -z "$api_key" ]; then
    echo "NOKEY"
    return 0
  fi

  # Build curl command
  local curl_args=(-s --max-time 10)
  curl_args+=(-X POST "${base_url}/v1/chat/completions")
  curl_args+=(-H "Authorization: Bearer ${api_key}")
  curl_args+=(-H "Content-Type: application/json")
  curl_args+=(-d "{\"model\":\"${model_id}\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":1}")

  local response
  local http_code

  response=$(curl "${curl_args[@]}" 2>&1) || {
    echo "FAIL"
    return 0
  }

  # Check for error responses
  if echo "$response" | grep -q '"error"'; then
    echo "FAIL"
  else
    echo "OK"
  fi
}

# ─────────────────────────────────────────────────────────────
#  Rank Models
# ─────────────────────────────────────────────────────────────

rank_models() {
  local -n MODELS_REF="$1"
  local -n RESULTS_REF="$2"

  # Build sorted list by tier
  local tier_groups=""
  for tier in $TIER_ORDER; do
    tier_groups="${tier_groups}${temp:+$'\n'}"
    temp=""
    for model in "${MODELS_REF[@]}"; do
      local model_id="${model#*/}"
      local actual_tier
      actual_tier=$(get_model_tier "$model_id")
      if [ "$actual_tier" = "$tier" ]; then
        temp="${temp:+$temp$'\n'}${model}"
      fi
    done
    [ -n "$temp" ] && tier_groups="${tier_groups}${temp}"
  done

  # Sort within each tier alphabetically
  local sorted=()
  local current_tier=""
  local tier_lines=""

  while IFS= read -r line; do
    [ -z "$line" ] && continue
    local model_id="${line#*/}"
    local actual_tier
    actual_tier=$(get_model_tier "$model_id")

    if [ "$actual_tier" != "$current_tier" ]; then
      if [ -n "$tier_lines" ]; then
        while IFS= read -r m; do
          [ -n "$m" ] && sorted+=("$m")
        done <<< "$(echo "$tier_lines" | sort)"
      fi
      current_tier="$actual_tier"
      tier_lines=""
    fi
    tier_lines="${tier_lines}${line}$'\n'"
  done <<< "$tier_groups"

  # Process last tier
  if [ -n "$tier_lines" ]; then
    while IFS= read -r m; do
      [ -n "$m" ] && sorted+=("$m")
    done <<< "$(echo "$tier_lines" | sort)"
  fi

  # Return tested models first, then untested
  local tested=()
  local untested=()
  for model in "${sorted[@]}"; do
    local status="${RESULTS_REF[$model]:-SKIP}"
    if [ "$status" = "OK" ]; then
      tested+=("$model")
    else
      untested+=("$model")
    fi
  done

  # Output tested first, then untested
  printf '%s\n' "${tested[@]}" "${untested[@]}"
}

# ─────────────────────────────────────────────────────────────
#  Show Results Table
# ─────────────────────────────────────────────────────────────

show_results_table() {
  local -n MODELS_REF="$1"
  local -n RESULTS_REF="$2"

  echo ""
  echo -e "${C_BOLD}Available Models:${C_RESET}"
  echo "─$(printf '─%.0s' {1..58})─"
  printf "  %-25s %-10s %s\n" "Model" "Provider" "Status"
  echo "─$(printf '─%.0s' {1..58})─"

  local idx=1
  for model in "${MODELS_REF[@]}"; do
    local provider="${model%%/*}"
    local status="${RESULTS_REF[$model]:-SKIP}"

    local status_text status_color
    case "$status" in
      OK)   status_text="✅ OK"   ; status_color="$C_GREEN" ;;
      FAIL) status_text="❌ FAIL"  ; status_color="$C_RED"   ;;
      NOKEY|SKIP) status_text="⚠️ No key" ; status_color="$C_YELLOW" ;;
      *)    status_text="⚠️ ${status}" ; status_color="$C_YELLOW" ;;
    esac

    printf "  %d) %-23s %-10s ${status_color}%s${C_RESET}\n" \
      "$idx" "$model" "$provider" "$status_text"
    idx=$((idx + 1))
  done

  echo "─$(printf '─%.0s' {1..58})─"
  echo ""
}

# ─────────────────────────────────────────────────────────────
#  Interactive Model Selection
# ─────────────────────────────────────────────────────────────

interactive_select() {
  local -n MODELS_REF="$1"
  local -n RESULTS_REF="$2"
  local -n CHAIN_REF="$3"

  CHAIN_REF=()

  local selected=()
  local done=false

  echo ""
  echo -e "${C_BOLD}Build your fallback chain (models used in order when primary fails):${C_RESET}"
  echo ""

  while ! $done; do
    echo -e "${C_CYAN}Current chain:${C_RESET}"
    if [ ${#selected[@]} -eq 0 ]; then
      echo "  (empty)"
    else
      local pos=1
      for m in "${selected[@]}"; do
        echo "  $pos) $m"
        pos=$((pos + 1))
      done
    fi
    echo ""

    echo "Select a model number to add (or 'done' to finish, 'undo' to remove last):"
    printf "  > "
    if [ ! -t 0 ]; then
      echo "done"
      done=true
    else
      read -r choice
    fi

    case "$choice" in
      done|DONE)
        done=true
        ;;
      undo|UNDO|remove|REMOVE)
        if [ ${#selected[@]} -gt 0 ]; then
          echo "  Removed: ${selected[-1]}"
          selected=("${selected[@]::${#selected[@]}-1}")
        else
          echo "  Nothing to remove."
        fi
        ;;
      [0-9]*)
        if [ "$choice" -ge 1 ] && [ "$choice" -le ${#MODELS_REF[@]} ]; then
          local model="${MODELS_REF[$((choice - 1))]}"
          if [[ " ${selected[*]} " == *" $model "* ]]; then
            echo "  $model already in chain."
          else
            echo "  Added: $model"
            selected+=("$model")
          fi
        else
          echo "  Invalid selection."
        fi
        ;;
      *)
        echo "  Enter a number, 'done', or 'undo'."
        ;;
    esac
    echo ""
  done

  CHAIN_REF=("${selected[@]}")
}

# ─────────────────────────────────────────────────────────────
#  Auto-generate Chain (non-interactive)
# ─────────────────────────────────────────────────────────────

auto_generate_chain() {
  local -n MODELS_REF="$1"
  local -n RESULTS_REF="$2"
  local -n CHAIN_REF="$3"

  CHAIN_REF=()

  # Get ranked models
  local ranked
  ranked=$(rank_models MODELS_REF RESULTS_REF)

  local auto_chain=()
  while IFS= read -r model; do
    [ -n "$model" ] && auto_chain+=("$model")
  done <<< "$ranked"

  CHAIN_REF=("${auto_chain[@]}")
}

# ─────────────────────────────────────────────────────────────
#  Write OMF Config
# ─────────────────────────────────────────────────────────────

write_omf_config() {
  local -n CHAIN_REF="$1"
  local old_config="$2"

  # Preserve existing options and agents config
  local options_json
  local agents_json

  if [ -f "$OMF_CONFIG" ] && has_jq; then
    options_json=$(jq -c '.options // {}' "$OMF_CONFIG" 2>/dev/null || echo "{}")
    agents_json=$(jq -c '.fallback_models.agents // {}' "$OMF_CONFIG" 2>/dev/null || echo "{}")
  else
    options_json='{"max_retries":3,"cooldown_seconds":30,"retry_on_errors":[429,500,502,503,504],"notify_on_fallback":true}'
    agents_json="{}"
  fi

  # Build fallback_models array
  local chain_json="["
  local first=true
  for model in "${CHAIN_REF[@]}"; do
    [ -n "$model" ] || continue
    if $first; then
      chain_json="${chain_json}\"${model}\""
      first=false
    else
      chain_json="${chain_json},\"${model}\""
    fi
  done
  chain_json="${chain_json}]"

  # Write complete config
  cat > "$OMF_CONFIG" << CONFIG_EOF
{
  "fallback_models": {
    "default": $chain_json,
    "agents": $agents_json
  },
  "options": $options_json
}
CONFIG_EOF
}

# ─────────────────────────────────────────────────────────────
#  Configure Mode
# ─────────────────────────────────────────────────────────────

configure_mode() {
  echo "== omf configurator =="
  echo ""

  # Discover models
  echo -e "${C_CYAN}Scanning for configured models...${C_RESET}"
  local -a MODELS=()
  discover_models MODELS

  if [ ${#MODELS[@]} -eq 0 ]; then
    echo -e "${C_YELLOW}No models found in config files.${C_RESET}"
    echo ""
    echo "To configure fallback models, add them to:"
    echo "  - ${CONFIG_DIR}/oh-my-openagent.json"
    echo "  - ${CONFIG_DIR}/omf.json"
    echo "  - ${CONFIG_DIR}/opencode.json"
    echo ""
    echo "Or set API keys via environment variables:"
    echo "  OPENAI_API_KEY, ANTHROPIC_API_KEY, DEEPSEEK_API_KEY, GROQ_API_KEY"
    echo ""
    echo "Then run --configure again."
    return 0
  fi

  echo "  Found ${#MODELS[@]} model(s)"

  # Discover providers
  local -A PROVIDERS
  discover_providers PROVIDERS

  # Test models
  echo ""
  echo -e "${C_CYAN}Testing model endpoints...${C_RESET}"
  local -A RESULTS
  local idx=1
  local total=${#MODELS[@]}

  for model in "${MODELS[@]}"; do
    printf "  Testing [%d/%d] %s... " "$idx" "$total" "$model"
    local status
    status=$(test_model "$model")
    RESULTS["$model"]="$status"

    case "$status" in
      OK)   echo -e "${C_GREEN}OK${C_RESET}" ;;
      FAIL) echo -e "${C_RED}FAIL${C_RESET}" ;;
      NOKEY|SKIP) echo -e "${C_YELLOW}No key${C_RESET}" ;;
      *)    echo -e "${C_YELLOW}${status}${C_RESET}" ;;
    esac

    idx=$((idx + 1))
  done

  # Show results table
  show_results_table MODELS RESULTS

  # Build chain
  local -a CHAIN=()

  if is_tty; then
    interactive_select MODELS RESULTS CHAIN

    if [ ${#CHAIN[@]} -eq 0 ]; then
      echo -e "${C_YELLOW}No models selected. Config unchanged.${C_RESET}"
      return 0
    fi

    echo -e "${C_BOLD}Final fallback chain:${C_RESET}"
    local pos=1
    for model in "${CHAIN[@]}"; do
      echo "  $pos) $model"
      pos=$((pos + 1))
    done
  else
    echo -e "${C_CYAN}Non-interactive mode: auto-generating chain...${C_RESET}"
    auto_generate_chain MODELS RESULTS CHAIN

    if [ ${#CHAIN[@]} -eq 0 ]; then
      echo -e "${C_YELLOW}No usable models found. Config unchanged.${C_RESET}"
      return 0
    fi

    echo -e "${C_BOLD}Auto-generated fallback chain:${C_RESET}"
    local pos=1
    for model in "${CHAIN[@]}"; do
      echo "  $pos) $model"
      pos=$((pos + 1))
    done
  fi

  echo ""

  if $APPLY; then
    local old_config=""
    [ -f "$OMF_CONFIG" ] && old_config="$OMF_CONFIG"
    write_omf_config CHAIN "$old_config"
    echo -e "${C_GREEN}Config written to ${OMF_CONFIG}${C_RESET}"
  else
    echo -e "${C_YELLOW}[DRY-RUN] Would write config with fallback chain.${C_RESET}"
    echo "Run with --apply to save changes."
  fi

  return 0
}

# ─────────────────────────────────────────────────────────────
#  Main Flow
# ─────────────────────────────────────────────────────────────

if $CONFIGURE; then
  configure_mode
  exit $?
fi

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

      # Use jq if available (safest), else awk targeting only the "plugin" key
      if has_jq; then
        jq --arg entry "$PLUGIN_ENTRY" '.plugin += [$entry]' "${CONFIG_FILE}" > "${TMP}" \
          && mv "${TMP}" "${CONFIG_FILE}" \
          && echo "  [DONE]   Plugin entry added via jq"
      else
        # awk: insert into the "plugin" array only — never the first ] in the file
        awk -v entry="\"${PLUGIN_ENTRY}\"" '
          BEGIN { in_plugin = 0; done = 0 }

          # Detect "plugin": [ line — start tracking
          /"plugin"[[:space:]]*:[[:space:]]*\[/ {
            in_plugin = 1
            print
            next
          }

          # Inside plugin section, at closing bracket: insert before it
          in_plugin && /^[[:space:]]*\]/ && !done {
            print "    " entry ","
            print "  ]"
            in_plugin = 0
            done = 1
            next
          }

          # Inside plugin section, line is NOT the closing bracket
          in_plugin && !done { print; next }

          # Already inserted — pass through
          { print }
        ' "${CONFIG_FILE}" > "${TMP}" && mv "${TMP}" "${CONFIG_FILE}"
        echo "  [DONE]   Plugin entry added to opencode.json"
      fi
    fi
  fi
fi

# ── 4. Install omf skill ──────────────────────────────────────
SKILL_SRC="${OMF_SRC}/SKILL.md"
SKILL_DIR="${CONFIG_DIR}/skills/omf"
SKILL_DST="${SKILL_DIR}/SKILL.md"

if [ -f "$SKILL_SRC" ]; then
  if [ -f "$SKILL_DST" ]; then
    echo "  [EXISTS]  omf skill (${SKILL_DST})"
  else
    echo "  [INSTALL] omf skill → ${SKILL_DST}"
    if $APPLY; then
      mkdir -p "${SKILL_DIR}"
      cp "$SKILL_SRC" "$SKILL_DST"
      echo "  [DONE]    Skill installed. Type \"/omf status\" in OpenCode to use."
    else
      echo "  [DRY-RUN] Would install skill to ${SKILL_DST}"
    fi
  fi
else
  echo "  [SKIP]    SKILL.md not found at ${SKILL_SRC}"
fi

echo ""
if $APPLY; then
  echo "== Install complete. Restart OpenCode for changes to take effect. =="
else
  echo "== Dry-run complete. Run with --apply to make changes. =="
fi