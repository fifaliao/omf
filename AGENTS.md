# omf — Oh My Fallback

OpenCode plugin for unified model fallback management.

## Project Structure

```
omf/
├── index.js      # Main plugin (ES module, ~512 lines)
├── install.sh    # Install script (--apply to apply, --configure for interactive setup)
├── package.json  # Minimal — no build/test scripts
├── README.md     # Full documentation (EN)
└── README.zh.md  # Documentation (CN)
```

**No build step, no tests, no TypeScript.** Pure JavaScript ES module. **No external dependencies** — `npm install` is never needed.

## Developer Workflow

1. Edit `index.js`
2. Restart OpenCode to test changes
3. Check `[omf]` prefixed log output for debugging

```
[omf] Loaded config from /home/user/.config/opencode/omf.json
[omf] fallback → opencode/big-pickle
```

## Architecture

**Two fallback modes:**

| Session Type | How Fallback Works |
|---|---|
| Manual (no agent) | `omf` handles it directly — aborts request, re-prompts with next model |
| Agent (sisyphus, etc.) | Writes `fallback_models` to `~/.config/opencode/oh-my-openagent.json` — oh-my-opencode's native runtime handles it |

**Plugin API contract:** Exports a default async function matching OpenCode's `PluginInput → PluginHooks` signature:
```js
export default async (input, options?: { configDir?: string }) => PluginHooks
```

**Config:** `~/.config/opencode/omf.json` (created on first load). Pass `configDir` option to override. Path adapts per platform: `%APPDATA%\opencode\` (Windows), `$XDG_CONFIG_HOME/opencode` or `~/.config/opencode` (Linux/macOS).

**Agent detection:** Session ID is matched against known agent names via regex. Manual sessions have no agent name in the session ID.

## Key Files

- `index.js:129-133` — known agent names list (up-to-date in code, not docs). **Sorted longest-first** in regex to prevent substring match of short names inside longer ones.
- `index.js:53-63` — `deepMerge` utility. Hand-rolled, 1 level deep, arrays replaced not merged.
- `index.js:149-172` — error/status code extraction and retryable error classification
- `index.js:65-89` — `loadConfig`: merges user config over defaults, writes default if missing
- `index.js:48-100` — `OMO_MODEL_DB`: built-in model capability database with `classify()`, `rank()`, `optimize()`
- `index.js:193-256` — `discoverAvailableModels()`: scans oh-my-openagent.json and opencode.json for model strings
- `index.js:258-297` — `autoOptimizeConfig()`: ranks discovered models by tier (premium>balanced>fast>cheap), updates fallback chain at runtime
- `install.sh` — `--apply` to apply, `--configure` for interactive model selection. Supports online/piped install: `curl ... | bash -s -- --apply`

## Model Capability Database

`OMO_MODEL_DB` in `index.js` classifies models into 4 tiers:

| Tier | Score | Examples |
|---|---|---|
| premium | 100 | big-pickle, gpt-5, claude-sonnet-4, claude-opus |
| balanced | 80 | claude-sonnet, gpt-4, gpt-4o, gemini-pro, deepseek-v3 |
| fast | 60 | claude-haiku, gpt-4-mini, gemini-flash, deepseek-chat |
| cheap | 40 | gpt-3.5, mixtral, llama |

Enable auto-optimization by setting `auto_optimize: true` in `omf.json`.

## Common Tasks

**Add a new known agent name:** Edit `AGENT_NAMES` array at `index.js:129-133`

**Add/update model capability tier:** Edit `OMO_MODEL_DB.tiers` patterns in `index.js:48-100`

**Run interactive model config:**
```bash
./install.sh --configure --apply
```

**Change retryable HTTP status codes:** Edit `config.options.retry_on_errors` in `~/.config/opencode/omf.json`

**Override config directory:** Pass `{ configDir: '/custom/path' }` as second arg to the plugin function

**Debug:** Look for `[omf]` prefixed console output in OpenCode logs

## Installation for Development

```bash
./install.sh          # preview (no changes)
./install.sh --apply  # register plugin + create default config
```

Or manually add to `~/.config/opencode/opencode.json`:
```json
{ "plugin": ["file:///path/to/omf"] }
```