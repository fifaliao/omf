# omf — Oh My Fallback

OpenCode plugin for unified model fallback management.

## Project Structure

```
omf/
├── index.js      # Main plugin (ES module, ~355 lines)
├── install.sh    # Installation script (dry-run by default, --apply to apply)
├── package.json  # Minimal — no build/test scripts
└── README.md     # Full documentation
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

**Config:** `~/.config/opencode/omf.json` (created on first load). Pass `configDir` option to override.

**Agent detection:** Session ID is matched against known agent names via regex. Manual sessions have no agent name in the session ID.

## Key Files

- `index.js:129-133` — known agent names list (up-to-date in code, not docs). **Sorted longest-first** in regex to prevent substring match of short names inside longer ones.
- `index.js:53-63` — `deepMerge` utility. Hand-rolled, 1 level deep, arrays replaced not merged.
- `index.js:149-172` — error/status code extraction and retryable error classification
- `index.js:65-89` — `loadConfig`: merges user config over defaults, writes default if missing
- `install.sh` — must run with `--apply` flag to modify config files. Also supports online/piped install: `curl ... | bash -s -- --apply`

## Common Tasks

**Add a new known agent name:** Edit `AGENT_NAMES` array at `index.js:129-133`

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