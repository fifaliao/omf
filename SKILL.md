---
name: omf
description: "Use when the user types /omf or asks about omf model fallback configuration. Manages retry logic, fallback chain order, and model fallback optimization for OpenCode."
---

# omf — Oh My Fallback Configuration

Handle `/omf` requests by reading/writing the `omf.json` config file directly. The config lives at the platform-appropriate config directory (`~/.config/opencode/omf.json` on Linux/macOS, `%APPDATA%\opencode\omf.json` on Windows).

## Quick Reference

| Command | Action |
|---|---|
| `/omf` | Show TUI menu |
| `/omf status` | Show full config details |
| `/omf optimize [strategy]` | Auto-discover via `opencode models` CLI, rank by strategy |
| `/omf init` | Interactive init: discover models + agents, build chain |

## Detection

When the user types `/omf` or a variant in their message, immediately load this skill and announce:

> "Using the omf skill to manage fallback configuration."

## Workflow

### 1. Find the config file

The config file location adapts per platform:
- Linux/macOS: `~/.config/opencode/omf.json` (or `$XDG_CONFIG_HOME/opencode/omf.json`)
- Windows: `%APPDATA%\opencode\omf.json`

### 2. Read current config

Read `omf.json` with your file tools. The schema is:

```json
{
  "fallback_models": {
    "default": ["opencode/big-pickle", "axon/gpt-5.4", "axon/claude-sonnet"]
  },
  "fallback_chain": {
    "strategy": "performance",
    "head": "opencode/big-pickle",
    "links": {}
  },
  "options": {
    "max_retries": 3,
    "cooldown_seconds": 30,
    "retry_on_errors": [429, 500, 502, 503, 504],
    "notify_on_fallback": true,
    "auto_optimize": false
  }
}
```

If the file doesn't exist, create it with sensible defaults.

### 3. Handle the subcommand

#### `/omf` or `/omf status`
Read and display the current config in a readable format. Show:
- Fallback chain order with numbered positions and tier labels
- Options summary (max_retries, cooldown, auto_optimize, detection flags)
- Evolution status (enabled/disabled with thresholds)

#### `/omf optimize [strategy]`
Discover available models via `opencode models` CLI, then build an optimized fallback chain.

1. Run `opencode models` to discover all available models
2. Classify each model into capability tiers (premium > balanced > fast > cheap)
3. Build a linked list chain with the given strategy (performance/price/feature/comprehensive)
4. Write the result to `omf.json`

Rank models by capability tier (from best to worst):
- **premium**: `big-pickle`, `gpt-5`, `claude-sonnet-4`, `claude-opus`
- **balanced**: `claude-sonnet`, `gpt-4`, `gpt-4o`, `gemini-pro`, `deepseek-v3`
- **fast**: `claude-haiku`, `gpt-4-mini`, `gemini-flash`, `deepseek-chat`
- **cheap**: `gpt-3.5`, `mixtral`, `llama`

Available strategies:
- `performance` (default): Highest tier first
- `price`: Cheapest first
- `feature`: Capability overlap with chain head
- `comprehensive`: 40% performance + 30% price + 30% feature

#### `/omf init`
Interactive discovery and configuration. Shows:
- All discovered models with tier labels and cost info
- Current subagent model assignments from `oh-my-openagent.json` (if present)
- Proposed unified fallback chain
- Prompts user to apply configuration

### 4. Edit config

Use file edit tools to modify `omf.json`. Always pretty-print with 2-space indentation.

After editing, always show the user a summary of what changed and the current state.

## Readline TUI (fallback)

If the user wants the interactive terminal TUI (e.g. `/omf tui`), run it via the install script:

```bash
cd <omf-plugin-dir> && bash install.sh --configure
```

Or call the omf plugin's exported `runTUI` function:

```bash
node -e "import('file://<omf-plugin-dir>/index.js').then(m => m.runTUI())"
```

The TUI uses Node.js built-in `readline` — no external dependencies needed.