# omf — Oh My Fallback

<p align="center">
  <a href="README.md"><strong>🇬🇧 English</strong></a> ·
  <a href="README.zh.md"><strong>🇨🇳 中文</strong></a>
</p>

Unified model fallback management for [OpenCode](https://opencode.ai).

## Overview

`omf` provides automatic model fallback for **manual sessions** in OpenCode. When your manually-selected model returns a retryable error (429, 5xx), `omf` automatically aborts the failed request and re-prompts with the next model in your fallback chain — without losing context.

For **agent sessions**, `omf` injects `fallback_models` into `oh-my-openagent.json` so that [oh-my-opencode](https://github.com/code-yeongyu/oh-my-openagent)'s built-in runtime fallback handles the retry.

## How It Works

```
Manual session
  ┌──────────┐    429/5xx      ┌──────────────┐
  │ Model A  │ ──────────────→ │ omf detects  │
  │ (failed) │                 │ error        │
  └──────────┘                 └──────┬───────┘
                                      │
                            ┌─────────▼─────────┐
                            │ 1. Check health    │
                            │    (evolve data)   │
                            │ 2. Check circuit   │
                            │    breaker         │
                            │    (provider)      │
                            └─────────┬─────────┘
                                      │
                            ┌─────────▼─────────┐
                            │ Abort failed       │
                            │ request            │
                            └─────────┬─────────┘
                                      │
                            ┌─────────▼─────────┐
                            │ Re-prompt with     │
                            │ healthiest model   │
                            │ from fallback      │
                            └─────────┬─────────┘
                                      │
                            ┌─────────▼─────────┐
                            │ Success →          │
                            │ conversation       │
                            │ continues          │
                            └───────────────────┘
```

## Installation

### Online install (one-liner)

Install directly from GitHub — no local clone needed:

```bash
# Preview (no changes)
curl -fsSL https://raw.githubusercontent.com/fifaliao/omf/main/install.sh | bash

# Apply
curl -fsSL https://raw.githubusercontent.com/fifaliao/omf/main/install.sh | bash -s -- --apply
```

The script auto-detects online mode, clones the repo to the platform-appropriate plugin directory (e.g., `~/.config/opencode/plugins/omf` on Linux/macOS or `%APPDATA%\opencode\plugins\omf` on Windows), registers the plugin, and creates the default config.

### Local install (development)

```bash
# Clone / copy to your machine, then:
cd /path/to/omf
chmod +x install.sh
./install.sh          # preview
./install.sh --apply  # apply changes
```

Or manually:

1. Add to your `~/.config/opencode/opencode.json` plugin array:

```json
{
  "plugin": [
    "file:///path/to/omf",
    "...other plugins..."
  ]
}
```

2. Restart OpenCode.

3. Verify it loaded by checking the logs for `[omf]` messages.

### Interactive Configuration

Use the `--configure` flag to discover, test, and select fallback models interactively:

```bash
./install.sh --configure --apply
```

This will:
1. **Discover** models from your OpenCode config files (`oh-my-openagent.json`, `opencode.json`, `omf.json`)
2. **Test** each model by making a lightweight API call to its provider endpoint
3. **Show** results in a formatted table (✅ OK / ❌ Failed / ⚠️ No key)
4. **Let you select** the fallback chain order interactively
5. **Write** the optimized config to `omf.json`

In non-interactive (CI/pipe) mode, it auto-generates an optimized chain using the built-in model capability database.

### Interactive Configuration (TUI)

The TUI configuration screen opens an interactive terminal menu using Node.js `readline`. Call it programmatically:

```js
import { runTUI } from 'omf';
await runTUI(); // uses default config dir
await runTUI('/custom/config/path'); // custom config dir
```

Or use the shell installer's `--configure` flag for the same interactive flow:

```bash
./install.sh --configure --apply
```

The TUI supports:
- **Show status** — view current fallback chain, per-agent overrides, and options
- **Auto-optimize** — discover models from your configs and build an optimized chain
- **Manual chain** — enter models one by one with format validation
- **Edit options** — change max_retries, cooldown, auto_optimize, notify, detection settings
- **Init** — discover all agents and models, then configure per-agent fallback chains

### omf Skill (In-Chat Configuration)

Installed automatically by `install.sh --apply`. The skill teaches OpenCode to handle `/omf` commands in the chat by directly editing `omf.json` using file tools. Try:

```
/omf status      # show current config
/omf optimize    # auto-discover and rank models
/omf init        # discover all agents & models, configure per-agent fallback chains
/omf add axon/deepseek  # add model to chain
/omf remove 3    # remove model at position 3
/omf retries 5   # set max_retries
/omf evolve on   # enable self-evolving fallback chain
/omf evolve status  # show performance stats for each model
```

### Self-Evolution

Enabled by default. Tracks model call outcomes (success/failure/latency) and automatically re-orders the fallback chain:

- **Promote** models with ≥70% success rate to the top of the chain
- **Demote** models with ≤30% success rate to the bottom
- **Discover** new models appearing in configs and auto-append them
- Data is stored in `evolve.jsonl` in the config directory

Configure in `omf.json`:

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

### Auto-Optimization

Enable automatic fallback chain optimization on every plugin load by setting `auto_optimize: true` in `omf.json`:

```json
{
  "options": {
    "auto_optimize": true
  }
}
```

When enabled, omf ranks discovered models by capability tier (premium > balanced > fast > cheap) and adjusts the fallback chain at runtime.

### Manual Configuration

Edit the `omf.json` config file (location adapts per platform: `%APPDATA%\opencode\` on Windows, `~/.config/opencode/` on Linux/macOS) to customize:

```json
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
```

| Option | Description | Default |
|---|---|---|---|
| `fallback_models.default` | Fallback chain for manual sessions | 4 models |
| `fallback_models.agents` | Per-agent overrides (written to oh-my-openagent.json) | `{}` |
| `max_retries` | Max fallback attempts per session | 3 |
| `cooldown_seconds` | Seconds before retrying a failed model | 30 |
| `retry_on_errors` | HTTP status codes that trigger fallback | `[429, 500, 502, 503, 504]` |
| `notify_on_fallback` | Show toast when fallback triggers | `true` |
| `detect.empty` | Detect and retry on empty responses | `true` |
| `detect.refusal` | Detect and retry on AI refusal patterns ("I'm sorry...") | `true` |
| `detect.usage_limit` | Detect and retry on usage/quota exceeded messages (supports 中文: 额度失败, 余额不足) | `true` |
| `detect.custom_patterns` | Array of custom regex patterns for user-defined failure detection | `[]` |
| `health_check` | Skip models with recent failures (from evolve data) before fallback | `true` |
| `provider_cooldown_seconds` | Circuit breaker: skip all models from a failing provider for N seconds | `60` |

### Per-agent fallback

To set fallback models for specific agents, add to the `agents` object:

```json
{
  "fallback_models": {
    "agents": {
      "sisyphus": [
        "opencode/big-pickle",
        "axon/gpt-5.4",
        "axon/deepseek"
      ],
      "oracle": [
        "axon/claude-opus",
        "axon/gpt-5.4"
      ]
    }
  }
}
```

On plugin load, `omf` writes these into `~/.config/opencode/oh-my-openagent.json` so oh-my-opencode's native fallback handles agent sessions.

## Plugin API

`omf` exports a default async function matching the OpenCode Plugin signature:

```typescript
export default async function plugin(
  input: PluginInput,
  options?: { configDir?: string }
): Promise<PluginHooks>
```

### Events handled

| Event | Action |
|---|---|---|
| `message.updated` | 1. Detects retryable errors (status codes, provider errors) → triggers fallback |
| | 2. Detects abnormal responses (empty, refusal patterns, usage limit) → triggers fallback |
| `session.error` | Session-level error detection (passive — defers to `message.updated`) |

### Detection Pipeline

```
message.updated
    │
    ├── Error check: retryable HTTP status? (429, 5xx) ──→ fallback
    │
    ├── Content check: empty response? ──────────────────→ fallback
    │
    ├── Content check: refusal pattern? ("I'm sorry...") ─→ fallback
    │
    ├── Content check: usage limit? (quota, 额度, 余额不足) ─→ fallback
    │
    └── Content check: custom patterns? (user-defined regex) ─→ fallback

fallback model selection:
    │
    ├── 1. Per-model cooldown: skip recently failed models
    │
    ├── 2. Provider circuit breaker: skip all models from failing provider
    │
    └── 3. Health check: skip models with recent failures (evolve.jsonl)
```

### Exported Functions

| Function | Description |
|---|---|
| `runTUI(configDir?)` | Launch interactive TUI configuration |
| `handleCommand({name, args})` | Handle `/omf` commands |
| `discoverAvailableModels(configDir)` | Discover all models from config files |
| `discoverAgentEntries(configDir)` | Discover all agents and categories from oh-my-openagent.json |
| `discoverProviderModels(configDir)` | Discover provider-defined models from opencode.json |
| `tuiInit(configDir, config)` | Interactive init: discover and configure all agents & models |
| `OMO_MODEL_DB.classify(modelStr)` | Classify model into capability tier |
| `OMO_MODEL_DB.rank(models)` | Rank models by capability tier |
| `OMO_MODEL_DB.optimize(models, max)` | Build optimized fallback chain |
| `logModelOutcome(configDir, model, success, latency, errorCode)` | Log model call outcome to evolve.jsonl |
| `analyzeModelPerformance(configDir, minObservations)` | Analyze evolve.jsonl for performance stats |
| `evolveFallbackChain(configDir, config)` | Run self-evolution on the fallback chain |

## Development

```bash
git clone <repo-url>
cd omf
# edit index.js
# restart OpenCode to test changes
```

## License

MIT
