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
  ┌──────────┐    429/5xx     ┌──────────────┐
  │ Model A  │ ─────────────→ │ omf detects  │
  │ (failed) │                │ error        │
  └──────────┘                └──────┬───────┘
                                     │
                            ┌────────▼────────┐
                            │ Abort failed     │
                            │ request          │
                            └────────┬────────┘
                                     │
                            ┌────────▼────────┐
                            │ Re-prompt with   │
                            │ Model B (next    │
                            │ fallback)        │
                            └────────┬────────┘
                                     │
                            ┌────────▼────────┐
                            │ Success →        │
                            │ conversation     │
                            │ continues        │
                            └─────────────────┘
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

The script auto-detects online mode, clones the repo to `~/.config/opencode/plugins/omf`, registers the plugin, and creates the default config.

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

Edit `~/.config/opencode/omf.json` to customize:

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
|---|---|---|
| `fallback_models.default` | Fallback chain for manual sessions | 4 models |
| `fallback_models.agents` | Per-agent overrides (written to oh-my-openagent.json) | `{}` |
| `max_retries` | Max fallback attempts per session | 3 |
| `cooldown_seconds` | Seconds before retrying a failed model | 30 |
| `retry_on_errors` | HTTP status codes that trigger fallback | `[429, 500, 502, 503, 504]` |
| `notify_on_fallback` | Show toast when fallback triggers | `true` |

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
|---|---|
| `message.updated` | Detects assistant errors with retryable status codes → triggers manual fallback |
| `session.error` | Session-level error detection (passive — defers to `message.updated`) |

## Development

```bash
git clone <repo-url>
cd omf
# edit index.js
# restart OpenCode to test changes
```

## License

MIT
