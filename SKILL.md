---
name: omf
description: "Use when the user types /omf or asks about omf model fallback configuration. Manages retry logic, fallback chain order, and model fallback optimization for OpenCode."
---

# omf — Oh My Fallback Configuration

Handle `/omf` requests by reading/writing the `omf.json` config file directly. The config lives at the platform-appropriate config directory (`~/.config/opencode/omf.json` on Linux/macOS, `%APPDATA%\opencode\omf.json` on Windows).

## Quick Reference

| Command | Action |
|---|---|
| `/omf` | Show status (current config overview) |
| `/omf status` | Show full config details |
| `/omf optimize` | Auto-discover and rank models |
| `/omf add <model>` | Add model to end of fallback chain |
| `/omf remove <n>` | Remove model at position N |
| `/omf set <n> <model>` | Replace model at position N |
| `/omf retries <n>` | Set max_retries |
| `/omf cooldown <n>` | Set cooldown_seconds |
| `/omf auto` | Toggle auto_optimize on/off |

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
    "default": ["model-a", "model-b", "model-c"],
    "agents": {
      "agent-name": ["model-x", "model-y"]
    }
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
- Fallback chain order with numbered positions
- Per-agent overrides (if any)
- Options summary

#### `/omf optimize`
Read the user's OpenCode config files to discover available models:
1. `~/.config/opencode/opencode.json` — extract model IDs from all providers
2. `~/.config/opencode/oh-my-openagent.json` — extract model strings
3. `~/.config/opencode/omf.json` — existing fallback chain

Rank models by capability tier (from best to worst):
- **premium**: `big-pickle`, `gpt-5`, `claude-sonnet-4`, `claude-opus`
- **balanced**: `claude-sonnet`, `gpt-4`, `gpt-4o`, `gemini-pro`, `deepseek-v3`
- **fast**: `claude-haiku`, `gpt-4-mini`, `gemini-flash`, `deepseek-chat`
- **cheap**: `gpt-3.5`, `mixtral`, `llama`

Build a chain by taking highest-tier models first, max 6 entries. Write the result to `omf.json`.

#### `/omf add <model>`
Read the current chain, append `<model>` to the end, write back.

#### `/omf remove <n>`
Remove the model at position N (1-based) from the chain.

#### `/omf set <n> <model>`
Replace the model at position N (1-based).

#### `/omf retries <n>`
Update `options.max_retries`.

#### `/omf cooldown <n>`
Update `options.cooldown_seconds`.

#### `/omf auto`
Toggle `options.auto_optimize` on/off.

#### `/omf agent <name> <models...>`
Set per-agent fallback: add/update `fallback_models.agents["<name>"]` with the listed models. Use `/omf agent <name>` (no models) to remove the agent override.

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
