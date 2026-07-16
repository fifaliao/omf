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
├── index.js       # Everything: plugin, model DB, TUI, command handler, evolution (2725 lines)
├── install.sh     # Install/config script: --apply, --configure for interactive setup
├── SKILL.md       # OpenCode skill definition for /omf in-chat commands
├── package.json   # Minimal — name, version, type:module, main, exports
├── README.md      # Full docs (CN)
├── README.zh.md   # Full docs (EN)
└── AGENTS.md      # This file
```

## Application Scenarios

omf works with **omo (oh-my-openagent)** for unified model fallback management:

| Scenario | How omf Handles It |
|---|---|
| **omo not installed** | `ensureOmoInstalled()` auto-adds `oh-my-openagent@latest` to `opencode.json` plugin list |
| **omo subagent model failure** | omf intercepts the error response, walks its chain, retries with next available model |
| **429 / 5xx / content anomaly** | omf detects via `isAbnormalResponse()` or `isRetryableError()`, falls back |
| **All models exhausted** | Returns failure, caller handles |

## Architecture

**omf is a full-control fallback plugin.** It intercepts `message.updated` (content anomalies), `session.error` (transport errors), and `session.status` (retry loops). omo's built-in `runtime-fallback` hook remains active. omf uses a **deferred-override coordination mechanism**:

| Layer | Handler | Events |
|-------|---------|--------|
| Transport errors (HTTP 5xx, 429, timeout) | omf (`session.error` — deferred) + omo runs first | omf's `setTimeout(0)` lets omo's retry start, then replaces it with omf's model |
| Content anomalies (empty, refusal, quota) | omf's `message.updated` hook (no omo conflict) | `message.updated` |
| Retry loops (rate-limit intercept) | omf's `session.status` hook | `session.status` |

### Coordination Mechanism (session.error)

When `session.error` fires:
1. **omo fires first** (setTimeout 0 defers omf) → aborts session → starts retry with omo's fallback model
2. **omf fires second** (deferred callback) → `session.abort()` kills omo's retry → `session.promptAsync()` starts retry with omf's chain model
3. **`session.abort()` is isolated** in its own try-catch → if omo already aborted, omf doesn't crash

### Plugin Startup Sequence (index.js:1273)

1. `loadConfig()` — merge user `omf.json` over defaults, write default if missing
2. `cleanOmoFallbacks()` — **only cleans `omf.json`** (legacy per-agent config); no longer touches `oh-my-openagent.json`
3. `autoOptimizeConfig()` — if `auto_optimize: true`, discover models via CLI and rebuild chain
4. `evolveFallbackChain()` — if `evolve.enabled: true`, reorder chain based on performance data

### Fallback Resolution — Two Modes

1. **Weight-based** (`options.weights.enabled: true`): Score all candidate models by success rate (70%) + latency (30%), pick highest scorer. Uses in-memory `modelStats` cache from `evolve.jsonl`.
2. **Linked-list walk** (default): Walk `fallback_chain.links[current]` → skip cooldown models → skip circuit-broken providers → re-prompt with next.

## Key Code Sections in index.js

| Section | Lines | What |
|---|---|---|
| `defaultConfig` | 48-93 | Default config values (fallback_models, options, model_tiers, evolve) |
| `ensureOmoInstalled` | 100-149 | Auto-adds `oh-my-openagent@latest` to opencode.json if not present |
| `TIER_SCORES` | 153 | `{ premium: 100, balanced: 80, fast: 60, cheap: 40 }` |
| `classifyByCost` | 155-162 | Secondary tier classification using model pricing from `opencode models --verbose` |
| `OMO_MODEL_DB` | 164-290 | Model capability database: `classify()`, `rank()`, `optimize()` |
| `deepMerge` | 294-304 | 1-level deep merge; arrays replaced, not concatenated |
| `loadConfig` | 306-329 | Read omf.json, merge over defaults, write default if absent |
| `discoverProviderApiModels` | 338-370 | Model discovery via `opencode models` CLI (30s timeout) |
| `parseVerboseModelOutput` | 372-429 | Parse interleaved model-ID + JSON from `opencode models --verbose` |
| `buildFallbackChain` | 448-512 | Score + sort models → build linked list. Cycle detection walks 5 steps; falls back to `performance` if cycle found |
| `buildDeepFallbackChain` | 525-602 | Builds chain where omo-required models prioritized first, all models have ≥3 non-repeating fallback hops |
| `createsCycle` | 614-623 | Helper: walks link map from proposedFallback, returns true if cycle detected |
| `autoOptimizeConfig` | 625-789 | Auto-rebuild chain on plugin load. Enhanced scoring: tier + success rate + latency + capability match |
| `EVOLVE_DEFAULTS` | 796-802 | `{ enabled: true, min_observations: 3, promote_threshold: 0.7, demote_threshold: 0.5, new_model_behavior: 'append' }` |
| `getEvolveLogPath` | 804-806 | Returns `join(configDir, 'evolve.jsonl')` |
| `logModelOutcome` / `recordModelOutcome` | 808-871 | Append to `evolve.jsonl` + update in-memory stats cache. Entry: `{t, m, s, l, e}` |
| `scoreModelWithWeights` | 873-892 | Score model: 70% success rate + 30% latency (inverse), neutral score (50) if insufficient data |
| `analyzeModelPerformance` | 894-934 | Read evolve.jsonl, return sorted array of `{model, successRate, avgLatency, totalCalls}` |
| `evolveFallbackChain` | 982-1051 | Promote ≥70% success rate models, demote ≤50% failure rate models, auto-discover new models |
| `getSessionModel` | 1128-1165 | Extract model ID from session: checks `state.currentFallbackModel` → omo config → STANDARD_OMO_CONFIG |
| `probeModel` | 2149-2281 | Single model probe via `session.promptAsync('.')` with 15s timeout. Returns `{ok, modelId, latency, error}` |
| `probeAvailableModels` | 2284-2329 | Probe all candidate models; records each result to evolve.jsonl when configDir is provided |
| `sinkModelToEnd` | 1061-1090 | Swap failed model with next in chain (moves back one position per failure), persists to omf.json immediately |
| `AGENT_NAMES` | 1094-1098 | Known agent names. **Must be sorted longest-first** (e.g. `sisyphus-junior` before `sisyphus`) |
| `extractAgentName` | 1100-1109 | Regex match session ID against AGENT_NAMES (longest-first sort prevents substring matching) |
| `isRetryableError` | 1124-1147 | Status code check + text pattern matching for rate-limit, timeout, network, model-not-found. Excludes `ProviderAuthError` and `MessageAbortedError` |
| `REFUSAL_PATTERNS` | 1149-1158 | RegExp array for detecting refusals ("I'm sorry...", "I cannot...", Chinese quota patterns) |
| `isAbnormalResponse` | 1167-1213 | Content detection pipeline: empty → usage_limit → refusal patterns → custom regex → model_gone (410) |
| `cleanOmoFallbacks` | 1247-1269 | Clean legacy per-agent fallback from omf.json only. **Does not touch oh-my-openagent.json** |
| `plugin()` (entry) | 1273-1566 | Main plugin function. Per-session state tracking (`failedModels`, `failedProviders` maps), cooldown/circuit-breaker, `tryManualFallback()` |
| `STANDARD_OMO_CONFIG` | 1904-1935 | Canonical mapping of all omo agent/category → model names (used by runInit for model replacement). Minimized duplicates: 17 unique models across 19 slots, feature-priority allocation. |
| `getStandardOmoModels` | 1884-1897 | Returns all unique model IDs from STANDARD_OMO_CONFIG |
| `getOmoRequiredModels` | 1802-1845 | Reads oh-my-opencode.json / oh-my-openagent.json, collects all model IDs from agents + categories sections |
| `updateOmoModels` | 1907-1966 | Strip version suffix from omo models to find free equivalents, write back to oh-my-opencode.json |
| `probeModel` | 1976-2019 | Send minimal "." prompt via `session.promptAsync()` with 15s timeout, return `{ok, modelId, error}` |
| `probeAvailableModels` | 2028-2057 | Probe all candidate models sequentially, return only those that respond successfully |
| `tuiInit` | 2061-2538 | 7-step interactive init: check omo → discover via CLI → filter by status/cost → probe (real API calls) → read omo requirements → build deep chain → apply |
| `runTUI` | 2564-2590 | TUI menu: show status / auto-optimize / manual chain / edit options / init |
| `handleCommand` | 2594-2701 | `/omf` command dispatcher |

## Model Tiers

| Tier | Score | Pattern examples |
|---|---|---|
| premium | 100 | `big-pickle`, `gpt-5`, `claude-sonnet-4`, `claude-opus`, `glm-5.1` |
| balanced | 80 | `claude-sonnet` (not `-4`), `gpt-4`, `gpt-4o`, `gemini-pro`, `deepseek-v3`, `deepseek-r1`, `glm-5`, `z-ai/`, `qwen/qwen3-*` |
| fast | 60 | `claude-haiku`, `gpt-4-mini`, `gemini-flash`, `deepseek-chat`, `deepseek-coder`, `glm-4.*`, `qwen`, `minimaxai/` |
| cheap | 40 | `gpt-3.5`, `mixtral`, `llama`, `command`, `dbrx`, `grok-4` |

Config tiers in `omf.json.model_tiers` override pattern-based classification. `classifyByCost()` is a secondary fallback using model pricing.

## Actual `/omf` Commands

| Command | Action |
|---|---|
| `/omf` | Default: launch TUI menu |
| `/omf status` or `/omf show` | Show chain, options, evolution status |
| `/omf optimize [strategy]` | Auto-discover models via CLI, build chain with strategy |
| `/omf chain` or `/omf manual` | Interactive manual chain builder |
| `/omf options` | Edit max_retries, cooldown, detect, health_check, etc. |
| `/omf init` or `/omf setup` | Full 7-step init: discover → probe → build chain → apply |
| `/omf evolve on/off/status/reset` | Self-evolution control |

**Note:** Commands `add`, `remove`, `set`, `retries`, `cooldown`, `auto` listed in some docs do NOT exist. Only the above are implemented.

## Config Location

Platform-adaptive: `%APPDATA%\opencode\omf.json` (Windows), `$XDG_CONFIG_HOME/opencode/omf.json` or `~/.config/opencode/omf.json` (Linux/macOS).

## Common Editing Points

**Add a known agent name:** `AGENT_NAMES` array at index.js:1094-1098. Remember: sort longest-first.

**Add a model tier pattern:** Edit `OMO_MODEL_DB.tiers` at index.js:168-238.

**Change detection behavior:** `isAbnormalResponse()` at index.js:1167-1213 and `REFUSAL_PATTERNS` at index.js:1149-1158.

**Change retryable errors:** Edit `isRetryableError()` at index.js:1124-1147 or `defaultConfig.options.retry_on_errors`.

**Evolution data:** Stored in `evolve.jsonl` (one JSON per line: `{t, m, s, l, e}`). Reset with `/omf evolve reset`.

## Gotchas

- **`deepMerge` is 1-level only.** Nested objects merge recursively, but arrays are replaced entirely, not concatenated.
- **`opencode models` CLI is the only discovery method.** `discoverProviderApiModels()` shells out to `opencode models` with a 120s timeout. If CLI fails, discovery returns empty. Model status is catalog metadata, NOT runtime availability.
- **Cycle detection in `buildFallbackChain`** walks 5 steps from each node. If a cycle is found, it **recursively** falls back to `performance` strategy.
- **omf and omo's runtime-fallback coexist via deferred-override.** Both hook `session.error`. omf's `setTimeout(0)` defers its handler so omo's handler runs first. omf then aborts omo's retry and starts its own.
- **`cleanOmoFallbacks` does not touch oh-my-openagent.json.** It only cleans legacy per-agent fallback config from `omf.json`.
- **Session state is in-memory only** (`sessionStates` Map). Restarting OpenCode clears all cooldown/circuit-breaker state.
- **`buildDeepFallbackChain` requires ≥4 models** for the 3-hop depth constraint. If fewer available, a warning is logged but the chain is still built.
- **`tuiInit` Step 3b probes real API availability.** This sends actual requests to each model with a 15s timeout per model. It requires plugin context (`_pluginCtx`) — if running standalone (no ctx), the probe is skipped.
- **`sinkModelToEnd` persists immediately** to omf.json after swapping the failed model with its successor. This means repeated failures will incrementally bubble the failing model toward the end of the chain.