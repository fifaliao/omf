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
├── index.js       # Everything: plugin, model DB, TUI, command handler, evolution (2100 lines)
├── install.sh     # Install/config script: --apply, --configure for interactive setup
├── SKILL.md       # OpenCode skill definition for /omf in-chat commands
├── package.json   # Minimal — name, version, type:module, main, exports
├── README.md      # Full docs (CN)
├── README.zh.md   # Full docs (EN)
└── AGENTS.md      # This file
```

## Application Scenarios

omf is designed to work with **omo (oh-my-openagent)** to provide unified model fallback management:

| Scenario | How omf Handles It |
|---|---|
| **omo not installed** | `ensureOmoInstalled()` auto-adds `oh-my-openagent@latest` to `opencode.json` plugin list |
| **omo subagent model failure** | omf intercepts the error response, walks its chain, retries with next available model |
| **429 / 5xx / content anomaly** | omf detects via `isAbnormalResponse()` or `isRetryableError()`, falls back |
| **All models exhausted** | Returns failure, caller handles (omo's runtime-fallback also inactive) |

## Architecture

**omf is a full-control fallback plugin (Option B).** It intercepts ALL fallback-relevant events — `message.updated` (content-level anomalies), `session.error` (transport errors), and `session.status` (retry loops) — and manages the entire fallback chain without modifying `oh-my-openagent.json`.

omo's built-in `runtime-fallback` hook remains active (configured by omo, not omf). Both hooks listen on the same events. omf uses a **deferred-override coordination mechanism** to ensure its fallback decisions take effect:

| Layer | Handler | Events |
|-------|---------|--------|
| Transport errors (HTTP 5xx, 429, timeout) | omf (`session.error` — deferred) + omo runs first | omf's `setTimeout(0)` lets omo's retry start, then replaces it with omf's model |
| Content anomalies (empty, refusal, quota) | omf's `message.updated` hook (no omo conflict) | `message.updated` |
| Retry loops (rate-limit intercept) | omf's `session.status` hook | `session.status` |

### Coordination Mechanism (session.error)

When `session.error` fires, both omf and omo's runtime-fallback handle it:

1. **omo fires first** (setTimeout 0 defers omf) → aborts session → starts retry with omo's fallback model
2. **omf fires second** (deferred callback) → `session.abort()` kills omo's retry → `session.promptAsync()` starts retry with omf's chain model
3. **`session.abort()` is isolated** in its own try-catch → if omo already aborted, omf doesn't crash — it continues to retry

This ensures omf's model choice wins regardless of handler dispatch order.

### `/omf init` Flow (6 Steps)

`/omf init` is the interactive initialization that can be re-run at any time to optimize the fallback chain:

| Step | What Happens |
|------|-------------|
| **1. Check omo install** | `ensureOmoInstalled()` verifies omo is in `opencode.json` plugin list, auto-adds if missing |
| **2. Discover models** | `discoverProviderApiModels(verbose=true)` via `opencode models` CLI → gets all models with `status` + `cost` metadata |
| **3. Filter availability** | Filters by `status === 'active'` + `cost === 0` (free). Inactive/paid filtered. Asks user about paid models. Unknown-status included by default. |
| **4. Read omo requirements** | `getOmoRequiredModels()` reads `oh-my-opencode.json` agents + categories sections → collects all model IDs omo uses |
| **5. Build deep chain** | `buildDeepFallbackChain()` builds chain where every model has ≥3 non-repeating fallback hops. omo-required models are prioritized first, remaining slots filled by tier order. Warns if chain length < 4 (can't satisfy depth constraint). |
| **6. Confirm and write** | User confirms → writes `omf.json` with chain + links + model_tiers |

### Plugin Startup Sequence (index.js:1098)

1. `loadConfig()` — merge user `omf.json` over defaults, write default if missing
2. `cleanOmoFallbacks()` — **only cleans `omf.json`** (legacy per-agent config); no longer touches `oh-my-openagent.json`
3. `autoOptimizeConfig()` — if `auto_optimize: true`, discover models via CLI and rebuild chain
4. `evolveFallbackChain()` — if `evolve.enabled: true`, reorder chain based on performance data

### Events Handled

| Event | Behavior |
|---|---|
| `message.updated` | Error + content detection pipeline → fallback if retryable anomaly detected |
| `session.status` | Intercept rate-limit retry loop → trigger fallback with omf's chain |
| `session.error` | Deferred override: let omo's handler run first, then replace retry with omf's model |

### Fallback Resolution — Two Modes

1. **Weight-based** (`options.weights.enabled: true`): Score all candidate models by success rate (70%) + latency (30%), pick the highest scorer. Uses in-memory `modelStats` cache from `evolve.jsonl`.
2. **Linked-list walk** (default): Walk `fallback_chain.links[current]` → skip cooldown models → skip circuit-broken providers → skip unhealthy models → re-prompt with next.

### Plugin API Contract

```js
export default async (input, options?) => PluginHooks
// options.configDir overrides config directory
```

## Key Code Sections in index.js

| Section | Lines | What |
|---|---|---|
| `defaultConfig` | 45-90 | Default config values (fallback_models, options, model_tiers, evolve) |
| `ensureOmoInstalled` | 92-146 | Auto-adds `oh-my-openagent@latest` to opencode.json if not present |
| `TIER_SCORES` | 150 | `{ premium: 100, balanced: 80, fast: 60, cheap: 40 }` |
| `classifyByCost` | 152 | Secondary fallback tier classification using model pricing data from `opencode models --verbose`. |
| `OMO_MODEL_DB` | 161-335 | Model capability database: `classify()`, `rank()`, `optimize()` |
| `deepMerge` | 339-349 | Hand-rolled 1-level deep merge; arrays replaced, not merged |
| `loadConfig` | 351-374 | Read omf.json, merge over defaults, write default if absent |
| `discoverProviderApiModels` | 382-413 | Model discovery — calls `opencode models` CLI. `verbose=true` uses `--verbose` to get cost + status metadata. |
| `parseVerboseModelOutput` | 416-464 | Parse interleaved model-ID + JSON from `opencode models --verbose`. Extracts `status`, `cost`, `providerID` from each model's JSON block. |
| `buildFallbackChain` | 464-536 | Score + sort models → build linked list. Cycle detection walks 5 steps; if cycle found, falls back to `performance` strategy. |
| `buildDeepFallbackChain` | 464-536 | Builds chain where all omo-required models are included first, all models have ≥3 non-repeating fallback hops. Used by `/omf init`. |
| `createsCycle` | 548-557 | Helper: walks link map from proposedFallback, returns true if `model` encountered. |
| `autoOptimizeConfig` | 559-662 | Auto-rebuild chain on plugin load. Enhanced scoring: tier + success rate + latency + capability match. |
| `logModelOutcome` / `recordModelOutcome` | 742-805 | Append to `evolve.jsonl` + update in-memory stats cache. Entry format: `{t, m, s, l, e}` (timestamp, model, success 0/1, latency ms, errorCode). |
| `AGENT_NAMES` | 989-993 | Known agent names for session detection. **Must be kept sorted longest-first** to prevent substring matching (e.g. `sisyphus-junior` before `sisyphus`). |
| `extractAgentName` | 995-1004 | Regex match session ID against AGENT_NAMES. Longest-first sort prevents short names matching inside longer ones. |
| `isRetryableError` | 1019-1035 | Status code check + text pattern matching for rate-limit, timeout, network, model-not-found errors. Excludes `ProviderAuthError` and `MessageAbortedError`. |
| `isAbnormalResponse` | 1057-1098 | Content detection pipeline: empty → usage_limit → refusal patterns → custom regex. |
| `cleanOmoFallbacks` | 1132-1149 | Clean legacy per-agent fallback from omf.json only. **Does not touch oh-my-openagent.json** — omo's runtime-fallback handles transport errors independently. |
| `plugin()` (entry) | 1158-1418 | Main plugin function. Per-session state tracking (`failedModels`, `failedProviders` maps), cooldown/circuit-breaker logic, `tryManualFallback()`. |
| `getOmoRequiredModels` | 1722-1769 | Extracts all model IDs from oh-my-opencode.json agents + categories sections. |
| `tuiInit` | 1773-1914 | 6-step interactive init: check omo → discover models → filter availability → read omo requirements → build deep chain → confirm & write. |
| `handleCommand` | 2015-2121 | `/omf` command dispatcher. |

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
| `/omf init` or `/omf setup` | Full 6-step init: check omo → discover → filter → read omo models → build deep chain → apply |
| `/omf evolve on/off/status/reset` | Self-evolution control |

**Note:** Commands `add`, `remove`, `set`, `retries`, `cooldown`, `auto` listed in some docs do NOT exist in the code. Only the above are implemented.

## Config Location

Platform-adaptive: `%APPDATA%\opencode\omf.json` (Windows), `$XDG_CONFIG_HOME/opencode/omf.json` or `~/.config/opencode/omf.json` (Linux/macOS). Override with `{ configDir: '/custom/path' }` option.

## Common Editing Points

**Add a known agent name:** `AGENT_NAMES` array at index.js:989-993. Remember: sort longest-first.

**Add a model tier pattern:** Edit `OMO_MODEL_DB.tiers` at index.js:165-235.

**Change detection behavior:** `isAbnormalResponse()` at index.js:1057-1098 and `REFUSAL_PATTERNS` at index.js:1037-1045.

**Change retryable errors:** Edit `isRetryableError()` at index.js:1019-1035 or `defaultConfig.options.retry_on_errors`.

**Evolution data:** Stored in `evolve.jsonl` (one JSON per line: `{t, m, s, l, e}`). Reset with `/omf evolve reset`.

## Gotchas

- **`deepMerge` is 1-level only.** Nested objects merge recursively, but arrays are replaced entirely, not concatenated.
- **`opencode models` CLI is the only discovery method.** `discoverProviderApiModels()` shells out to `opencode models` with a 30s timeout. `verbose=true` uses `--verbose` to get cost+status metadata. If CLI fails, discovery returns empty — no file-based fallback. Model status is catalog metadata, NOT runtime availability — actual availability is only determined through real API calls.
- **Cycle detection in `buildFallbackChain`** walks 5 steps from each node. If a cycle is found, it **recursively** falls back to `performance` strategy (cannot infinite-loop since performance strategy won't produce cycles).
- **omf and omo's runtime-fallback coexist via deferred-override.** Both hook `session.error`/`session.status`. omf's `setTimeout(0)` defers its handler so omo's handler runs first. omf then aborts omo's retry and starts its own — ensuring omf's fallback chain takes effect. If omo already aborted the session, omf's abort is wrapped in a try-catch and does not crash.
- **`cleanOmoFallbacks` does not touch oh-my-openagent.json.** It only cleans legacy per-agent fallback config from `omf.json`. omo's runtime-fallback hook and configuration are left completely untouched.
- **Session state is in-memory only** (`sessionStates` Map). Restarting OpenCode clears all cooldown/circuit-breaker state.
- **`buildDeepFallbackChain` requires ≥4 models for the 3-hop depth constraint** to be satisfiable. If fewer than 4 models are available, a warning is logged but the chain is still built.