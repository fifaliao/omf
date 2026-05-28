# omf — Oh My Fallback

<p align="center">
  <a href="README.md"><strong>🇬🇧 English</strong></a> ·
  <a href="README.zh.md"><strong>🇨🇳 中文</strong></a>
</p>

**Intelligent model fallback orchestration for [OpenCode](https://opencode.ai).**

When a model fails (error, empty response, refusal, quota exceeded), `omf` doesn't just retry linearly — it **walks a precomputed linked list** to the next-best model in O(1) time, skipping cooldowns, respecting circuit breakers, and preserving full conversation context.

---

## Why omf?

| Problem | omf Solution |
|---|---|
| 💥 Model returns 429/5xx | Auto-abort + retry next model in **O(1)** via linked list |
| 🤐 Model refuses or responds empty | Content-level detection (empty, refusal, usage limit, custom regex) |
| 🔥 Provider outage takes down all its models | Circuit breaker — skip entire provider for N seconds |
| 📉 Unknown model quality | Self-evolution tracks real outcomes and reorders the chain |
| 🎯 Manual vs agent need different fallback chains | Per-agent overrides in `omf.json`, zero coupling |
| 🧠 "Which model should fallback to what?" | 4 strategies — performance, price, feature match, comprehensive |

---

## How It Works

```
Any session (manual or agent)
     │
     ├── Model fails (429/5xx/empty/refusal/quota)
     │
     ▼
┌─────────────────────┐
│  omf detection       │
│  pipeline            │
│  • HTTP status check │
│  • Content check     │
│  • Custom regex      │
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  Health & safety     │
│  • Per-model cooldown│
│  • Provider breaker  │
│  • Health check      │
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  Linked list walk   │
│  O(1) fallback      │
│  resolution          │
│  (no linear scan)   │
└────────┬────────────┘
         │
         ▼
    Re-prompt with
    next model →
    conversation continues
```

### Linked List Architecture

Traditional fallback chains use flat arrays — every fallback scans from index 0, retrying models you've already failed. `omf` uses a **linked list**:

```json
{
  "fallback_chain": {
    "strategy": "performance",
    "head": "axon/claude-opus",
    "links": {
      "axon/claude-opus": "axon/gpt-5.3-codex",
      "axon/gpt-5.3-codex": "nvidia/meta/llama-4-maverick-17b-128e-instruct",
      "nvidia/meta/llama-4-maverick-17b-128e-instruct": "opencode/big-pickle",
      "...": "..."
    }
  }
}
```

Each model points to exactly **one fallback**. Resolution is O(1) — no index scanning, no duplicate retries across 5 hops. Cycle detection runs at build time; if a cycle is found, the chain auto-falls-back to `performance` strategy.

---

## 4 Fallback Strategies

`omf` scores **every model in your OpenCode installation** (118+ discovered via `opencode models`) and links them by priority.

| Strategy | Sorts By | Best For |
|---|---|---|
| `performance` | Tier score (premium > balanced > fast > cheap) | Maximum response quality |
| `price` | Inverted tier (cheap first) | Cost-sensitive workloads |
| `feature` | Capability overlap + tier alignment | Feature parity in fallback |
| `comprehensive` | 40% perf + 30% price + 30% feature | Balanced everything |

Set via `/omf optimize <strategy>` or in `omf.json` → `fallback_chain.strategy`.

```bash
# Performance-first (default)
/omf optimize

# Price-optimized
/omf optimize price

# Feature-match
/omf optimize feature

# Balanced
/omf optimize comprehensive
```

### Feature Strategy

`feature` match infers model capabilities by parsing model IDs:
- **vision**: image generation, vision-language models
- **code**: coder/codex/codeqwen variants
- **reasoning**: reasoner/reasoning models
- **fast**: flash/haiku/fast/mini/nano variants
- **streaming + tools**: all non-embedding models

A model that shares 60%+ capabilities with the chain head scores highest. Fallback preserves capability — not just tier.

---

## Installation

### Online install (one-liner)

```bash
# Preview (no changes)
curl -fsSL https://raw.githubusercontent.com/fifaliao/omf/main/install.sh | bash

# Apply
curl -fsSL https://raw.githubusercontent.com/fifaliao/omf/main/install.sh | bash -s -- --apply
```

The script auto-detects online mode, clones to `~/.config/opencode/plugins/omf` (Linux/macOS) or `%APPDATA%\opencode\plugins\omf` (Windows), registers the plugin, and creates default config.

### Local install

```bash
cd /path/to/omf
chmod +x install.sh
./install.sh          # preview
./install.sh --apply  # apply
```

Or manually add to `~/.config/opencode/opencode.json`:
```json
{ "plugin": ["file:///path/to/omf"] }
```
Then restart OpenCode. Verify with `[omf]` log messages.

### Interactive Configuration (TUI)

```bash
./install.sh --configure --apply
```

Or programmatically:
```js
import { runTUI } from 'omf';
await runTUI();                  // default config dir
await runTUI('/custom/path');    // custom config dir
```

TUI supports:
- **Show status** — view chain, strategies, per-agent overrides
- **Auto-optimize** — pick a strategy, build linked list, persist
- **Manual chain** — enter models with format validation
- **Edit options** — retries, cooldown, auto_optimize, detection
- **Init** — discover all agents and configure per-agent chains

---

## In-Chat Commands (`/omf`)

Installed automatically by `install.sh --apply`. The omf skill teaches OpenCode to edit config directly:

```
/omf status                  # show current config
/omf optimize [strategy]     # auto-discover 118+ models, build linked list
/omf add axon/deepseek       # append model to chain
/omf remove 3                # remove model at position 3
/omf set 2 axon/gpt-5.4      # replace model at position 2
/omf retries 5               # set max_retries
/omf cooldown 30             # set cooldown_seconds
/omf auto                    # toggle auto_optimize
/omf evolve on               # enable self-evolution
/omf evolve status           # show model performance stats
```

---

## Self-Evolution

Enabled by default. Tracks model call outcomes (success/failure/latency) and automatically reorders the chain:

- **Promote** models with ≥70% success rate to chain top
- **Demote** models with ≤30% success rate to chain bottom
- **Discover** new models appearing in configs and auto-append
- Data stored in `evolve.jsonl`

```json
{
  "evolve": {
    "enabled": true,
    "min_observations": 5,
    "promote_threshold": 0.7,
    "demote_threshold": 0.3,
    "max_chain_size": 6,
    "new_model_behavior": "append"
  }
}
```

---

## Auto-Optimization

Set `auto_optimize: true` in `omf.json` to rebuild the fallback chain on every plugin load:

```json
{ "options": { "auto_optimize": true } }
```

Runs `buildFallbackChain()` with the configured strategy, using all models discovered from `opencode models` CLI.

---

## Configuration

`omf.json` lives at the platform-appropriate config directory (`~/.config/opencode/` on Linux/macOS, `%APPDATA%\opencode\` on Windows).

```json
{
  "fallback_models": {
    "default": ["opencode/big-pickle", "axon/gpt-5.4", "axon/claude-sonnet"],
    "agents": {}
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
    "provider_cooldown_seconds": 60,
    "notify_on_fallback": true,
    "auto_optimize": false
  },
  "detect": {
    "empty": true,
    "refusal": true,
    "usage_limit": true,
    "custom_patterns": []
  }
}
```

| Option | Description | Default |
|---|---|---|
| `fallback_models.default` | Default fallback chain (flat array for display) | — |
| `fallback_models.agents` | Per-agent overrides in `omf.json` | `{}` |
| `fallback_chain.strategy` | Sorting strategy: performance/price/feature/comprehensive | `performance` |
| `fallback_chain.head` | Linked list head (first model to try) | first model in chain |
| `fallback_chain.links` | Linked list: each model → its fallback | — |
| `max_retries` | Max fallback attempts per session | 3 |
| `cooldown_seconds` | Seconds before retrying a failed model | 30 |
| `retry_on_errors` | HTTP status codes triggering fallback | `[429, 500, 502, 503, 504]` |
| `provider_cooldown_seconds` | Circuit breaker: skip all models from failing provider for N seconds | 60 |
| `notify_on_fallback` | Show toast on fallback | `true` |
| `detect.empty` | Detect and retry on empty responses | `true` |
| `detect.refusal` | Detect refusal patterns ("I'm sorry...") | `true` |
| `detect.usage_limit` | Detect quota/usage exceeded (中文: 额度失败, 余额不足) | `true` |
| `detect.custom_patterns` | User-defined failure regex array | `[]` |

### Per-agent fallback

```json
{
  "fallback_models": {
    "agents": {
      "sisyphus": ["opencode/big-pickle", "axon/gpt-5.4", "axon/deepseek"],
      "oracle": ["axon/claude-opus", "axon/gpt-5.4"]
    }
  }
}
```

On failure, `omf` reads the override and falls back within that agent's chain. If no override exists, the default chain is used.

---

## Plugin API

```typescript
export default async function plugin(
  input: PluginInput,
  options?: { configDir?: string }
): Promise<PluginHooks>
```

### Events handled

| Event | Action |
|---|---|
| `message.updated` | Error/content detection → fallback |
| `session.error` | Session-level error (passive, defers to `message.updated`) |

### Detection Pipeline

```
message.updated
    ├── HTTP status: 429, 5xx? ─────────────→ fallback
    ├── Empty response? ────────────────────→ fallback
    ├── Refusal pattern? ───────────────────→ fallback
    ├── Usage limit? ───────────────────────→ fallback
    └── Custom regex match? ────────────────→ fallback

Fallback resolution (linked list):
    ├── Advance via links[current]
    ├── Skip models on per-model cooldown
    ├── Skip models from circuit-broken providers
    └── Re-prompt with next model (context preserved)
```

### Exported Functions

| Function | Description |
|---|---|
| `runTUI(configDir?)` | Launch interactive TUI configuration |
| `handleCommand({name, args})` | Handle `/omf` commands |
| `buildFallbackChain(models, strategy)` | Score + sort + build linked list (4 strategies) |
| `discoverAvailableModels(configDir)` | Discover models from `opencode models` CLI + configs |
| `discoverProviderApiModels(configDir)` | Discover models via `opencode models` CLI (sole method) |
| `discoverAgentEntries(configDir)` | Discover agents from `oh-my-openagent.json` |
| `tuiInit(configDir, config)` | Interactive init: discover and configure all agents |
| `tuiAutoOptimize(configDir, config)` | Auto-optimize with strategy selection |
| `OMO_MODEL_DB.classify(modelId)` | Classify model into capability tier |
| `OMO_MODEL_DB.rank(models)` | Rank by tier score |
| `OMO_MODEL_DB.optimize(models, max)` | Build optimized chain (legacy, prefers `buildFallbackChain`) |
| `logModelOutcome(configDir, model, success, latency, errorCode)` | Log outcome to `evolve.jsonl` |
| `analyzeModelPerformance(configDir, minObservations)` | Analyze evolution data |
| `evolveFallbackChain(configDir, config)` | Run self-evolution |

---

## Development

```bash
git clone <repo-url>
cd omf
# edit index.js
# restart OpenCode to test
```

**No build step. No tests. No TypeScript.** Pure ES module. Zero external dependencies — `npm install` never needed.

Look for `[omf]` prefixed log output for debugging.

---

## License

MIT
