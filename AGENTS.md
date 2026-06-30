# omf — Oh My Fallback

OpenCode plugin for unified model fallback management. Single file, zero dependencies.

## Essentials

- **No build step. No tests. No TypeScript.** Pure ES module (`"type": "module"` in package.json).
- **No `npm install` ever.** Zero external dependencies — only Node built-ins (`fs`, `path`, `child_process`, `readline`).
- **Test:** Edit `index.js` → restart OpenCode → check `[omf]` prefixed logs.
- **Package:** `package.json` has no `scripts` — there is nothing to `npm run`.

## Project Structure

```
omf/
├── index.js       # Everything: plugin, model DB, TUI, command handler, evolution (1778 lines)
├── install.sh     # Install/config script: --apply, --configure for interactive setup
├── SKILL.md       # OpenCode skill definition for /omf in-chat commands
├── package.json   # Minimal — name, version, type:module, main, exports
├── README.md      # Full docs (CN)
├── README.zh.md   # Full docs (EN)
└── AGENTS.md      # This file
```

## Architecture

**omf absorbs all fallback responsibility.** On startup, `cleanOmoFallbacks()` strips `fallback_models` from `oh-my-openagent.json` and disables its `runtime_fallback`. Fallback chains live only in `omf.json`; omf performs the abort + retry itself.

### Plugin Startup Sequence (index.js:1011-1022)

1. `loadConfig()` — merge user `omf.json` over defaults, write default if missing
2. `cleanOmoFallbacks()` — strip legacy fallback from `oh-my-openagent.json`, disable its runtime fallback
3. `autoOptimizeConfig()` — if `auto_optimize: true`, discover models via CLI and rebuild chain
4. `evolveFallbackChain()` — if `evolve.enabled: true`, reorder chain based on performance data

### Events Handled

| Event | Behavior |
|---|---|
| `message.updated` | Error + content detection pipeline → fallback if retryable |
| `session.status` | Intercept OpenCode's built-in retry loop (429/rate-limit at attempt ≥ 1) → skip to omf fallback instead |
| `session.error` | Session-level error → delegate to fallback if retryable |

### Fallback Resolution — Two Modes

1. **Weight-based** (`options.weights.enabled: true`): Score all candidate models by success rate (70%) + latency (30%), pick the highest scorer. Uses in-memory `modelStats` cache from `evolve.jsonl`.
2. **Linked-list walk** (default/legacy): Walk `fallback_chain.links[current]` → skip cooldown models → skip circuit-broken providers → skip unhealthy models → re-prompt with next.

### Plugin API Contract

```js
export default async (input, options?) => PluginHooks
// options.configDir overrides config directory
```

## Key Code Sections in index.js

| Section | Lines | What |
|---|---|---|
| `defaultConfig` | 45-90 | Default config values (fallback_models, options, model_tiers, evolve) |
| `TIER_SCORES` | 94 | `{ premium: 100, balanced: 80, fast: 60, cheap: 40 }` |
| `OMO_MODEL_DB` | 105-231 | Model capability database: `classify()`, `rank()`, `optimize()` |
| `deepMerge` | 235-245 | Hand-rolled 1-level deep merge; arrays replaced, not merged |
| `loadConfig` | 247-270 | Read omf.json, merge over defaults, write default if absent |
| `discoverProviderApiModels` | 279-300 | **Only method** for model discovery — calls `opencode models` CLI. No file-based discovery. |
| `buildFallbackChain` | 319-383 | Score + sort models → build linked list. Cycle detection walks 5 steps; if cycle found, falls back to `performance` strategy. |
| `autoOptimizeConfig` | 385-549 | Auto-rebuild chain on plugin load. Enhanced scoring: tier + success rate + latency + capability match. |
| `logModelOutcome` / `recordModelOutcome` | 568-631 | Append to `evolve.jsonl` + update in-memory stats cache. Entry format: `{t, m, s, l, e}` (timestamp, model, success 0/1, latency ms, errorCode). |
| `AGENT_NAMES` | 815-819 | Known agent names for session detection. **Must be kept sorted longest-first** to prevent substring matching (e.g. `sisyphus-junior` before `sisyphus`). |
| `extractAgentName` | 821-830 | Regex match session ID against AGENT_NAMES. Longest-first sort prevents short names matching inside longer ones. |
| `isRetryableError` | 845-861 | Status code check + text pattern matching for rate-limit, timeout, network, model-not-found errors. Excludes `ProviderAuthError` and `MessageAbortedError`. |
| `isAbnormalResponse` | 880-921 | Content detection pipeline: empty → usage_limit → refusal patterns → custom regex. |
| `cleanOmoFallbacks` | 955-1029 | Strip `fallback_models` from oh-my-openagent.json entries, set `runtime_fallback.enabled=false`, add `"runtime-fallback"` to `disabled_hooks` (prevents hook registration), set `model_fallback=false`. Runs on every plugin load — omf must own all fallback logic. |
| `plugin()` (entry) | 1011-1272 | Main plugin function. Per-session state tracking (`failedModels`, `failedProviders` maps), cooldown/circuit-breaker logic, `tryManualFallback()`. |
| `handleCommand` | 1648-1755 | `/omf` command dispatcher. |

## Model Tiers

| Tier | Score | Pattern examples |
|---|---|---|
| premium | 100 | `opencode/big-pickle`, `axon/gpt-5`, `claude-sonnet-4`, `claude-opus`, `z-ai/glm-5.1` |
| balanced | 80 | `claude-sonnet` (not `-4`), `gpt-4`, `gpt-4o`, `gemini-pro`, `deepseek-v3`, `deepseek-r1`, `glm-5` |
| fast | 60 | `claude-haiku`, `gpt-4-mini`, `gemini-flash`, `deepseek-chat`, `deepseek-coder`, `glm-4.*` |
| cheap | 40 | `gpt-3.5`, `mixtral`, `llama`, `command` |

Config tiers in `omf.json.model_tiers` override pattern-based classification. `classifyByCost()` is a secondary fallback using model pricing.

## Actual `/omf` Commands

| Command | Action |
|---|---|
| `/omf` | Default: launch TUI menu |
| `/omf status` or `/omf show` | Show chain, options, evolution status |
| `/omf optimize [strategy]` | Auto-discover models via CLI, build chain with strategy |
| `/omf chain` or `/omf manual` | Interactive manual chain builder |
| `/omf options` | Edit max_retries, cooldown, detect, health_check, etc. |
| `/omf init` or `/omf setup` | Discover all models + agents, propose and apply chain |
| `/omf evolve on/off/status/reset` | Self-evolution control |

**Note:** Commands `add`, `remove`, `set`, `retries`, `cooldown`, `auto` listed in some docs do NOT exist in the code. Only the above are implemented.

## Config Location

Platform-adaptive: `%APPDATA%\opencode\omf.json` (Windows), `$XDG_CONFIG_HOME/opencode/omf.json` or `~/.config/opencode/omf.json` (Linux/macOS). Override with `{ configDir: '/custom/path' }` option.

## Common Editing Points

**Add a known agent name:** `AGENT_NAMES` array at index.js:815-819. Remember: sort longest-first.

**Add a model tier pattern:** Edit `OMO_MODEL_DB.tiers` at index.js:109-179.

**Change detection behavior:** `isAbnormalResponse()` at index.js:880-921 and `REFUSAL_PATTERNS` at index.js:863-872.

**Change retryable errors:** Edit `isRetryableError()` at index.js:845-861 or `defaultConfig.options.retry_on_errors`.

**Evolution data:** Stored in `evolve.jsonl` (one JSON per line: `{t, m, s, l, e}`). Reset with `/omf evolve reset`.

## Gotchas

- **`deepMerge` is 1-level only.** Nested objects merge recursively, but arrays are replaced entirely, not concatenated.
- **`opencode models` CLI is the only discovery method.** `discoverProviderApiModels()` shells out to `opencode models` with a 15s timeout. If CLI fails, discovery returns empty — no file-based fallback.
- **Cycle detection in `buildFallbackChain`** walks 5 steps from each node. If a cycle is found, it **recursively** falls back to `performance` strategy (cannot infinite-loop since performance strategy won't produce cycles).
- **`cleanOmoFallbacks` runs on every plugin load.** It strips `fallback_models` from oh-my-openagent.json entries, sets `runtime_fallback.enabled=false`, **adds `"runtime-fallback"` to `disabled_hooks`** (prevents omo's hook from registering at all — `enabled=false` alone is insufficient since the hook still races on events), and sets `model_fallback=false`. omf owns all fallback logic.
- **omo hook vs. omf fallback are mutually exclusive.** omo's runtime-fallback hook must be disabled via `disabled_hooks` (not just `runtime_fallback.enabled=false`) because the hook still registers and races with omf on `session.error`/`session.status` events even when `enabled=false`. Both hooks calling `session.abort()` would conflict.
- **Session state is in-memory only** (`sessionStates` Map). Restarting OpenCode clears all cooldown/circuit-breaker state.
