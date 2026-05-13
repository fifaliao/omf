/**
 * omf (oh-my-fallback) — OpenCode plugin for unified model fallback management.
 *
 * Two modes:
 *   MANUAL sessions (no agent): handles fallback itself — aborts failed request,
 *     re-prompts with next model from the fallback chain.
 *   AGENT sessions (sisyphus, etc.): writes fallback_models into
 *     oh-my-openagent.json so oh-my-opencode's built-in runtime-fallback handles it.
 *
 * Install:
 *   Add to opencode.json plugin array:
 *     "plugin": ["/path/to/omf"]
 *     or "plugin": ["omf@git+https://github.com/<user>/omf.git"]
 *
 * Config:
 *   Create ~/.config/opencode/omf.json (see defaultConfig below for structure)
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Default configuration ────────────────────────────────────────────────────

const defaultConfig = {
  fallback_models: {
    /* Fallback chain for manual sessions (no agent context) */
    default: [
      'opencode/big-pickle',
      'axon/gpt-5.4',
      'axon/claude-sonnet',
      'axon/deepseek',
    ],
    /*
     * Per-agent overrides written to oh-my-openagent.json on plugin load.
     * Agent sessions use oh-my-opencode's native runtime-fallback with these models.
     * Omit an agent to leave its existing fallback_models untouched.
     */
    agents: {},
  },
  options: {
    max_retries: 3,            // max fallback attempts per session
    cooldown_seconds: 30,      // seconds before retrying a failed model
    retry_on_errors: [429, 500, 502, 503, 504],
    notify_on_fallback: true,  // show toast when fallback triggers
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(result[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

function loadConfig(configDir) {
  const configPath = join(configDir, 'omf.json');
  let config = deepMerge({}, defaultConfig);

  if (existsSync(configPath)) {
    try {
      const userConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
      config = deepMerge(config, userConfig);
      console.log(`[omf] Loaded config from ${configPath}`);
    } catch (e) {
      console.error(`[omf] Failed to parse ${configPath}:`, e.message);
    }
  } else {
    // Write default config for user to edit
    try {
      mkdirSync(configDir, { recursive: true });
      writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2) + '\n', 'utf-8');
      console.log(`[omf] Created default config at ${configPath}`);
    } catch (e) {
      console.error(`[omf] Failed to write default config:`, e.message);
    }
  }

  return config;
}

function writeAgentFallbacks(configDir, config) {
  const agentModels = config.fallback_models?.agents;
  if (!agentModels || Object.keys(agentModels).length === 0) {
    return;
  }

  const agentConfigPath = join(configDir, 'oh-my-openagent.json');
  if (!existsSync(agentConfigPath)) {
    console.log(`[omf] oh-my-openagent.json not found at ${agentConfigPath}, skipping agent write`);
    return;
  }

  try {
    const raw = readFileSync(agentConfigPath, 'utf-8');
    const agentConfig = JSON.parse(raw);
    let modified = false;

    for (const [agentName, models] of Object.entries(agentModels)) {
      if (agentConfig.agents?.[agentName]) {
        agentConfig.agents[agentName].fallback_models = models;
        modified = true;
        console.log(`[omf] Set fallback_models for agent "${agentName}"`);
      } else {
        console.log(`[omf] Agent "${agentName}" not found in oh-my-openagent.json, skipping`);
      }
    }

    if (modified) {
      writeFileSync(agentConfigPath, JSON.stringify(agentConfig, null, 2) + '\n', 'utf-8');
      console.log(`[omf] Updated oh-my-openagent.json — restart OpenCode for changes to take effect`);
    }
  } catch (e) {
    console.error(`[omf] Failed to update oh-my-openagent.json:`, e.message);
  }
}

// ─── Agent name detection (mirrors oh-my-opencode's logic) ────────────────────

const AGENT_NAMES = [
  'sisyphus', 'hephaestus', 'prometheus', 'atlas',
  'oracle', 'librarian', 'explore', 'metis', 'momus',
  'sisyphus-junior', 'multimodal-looker',
];

const agentPattern = new RegExp(
  `\\b(${AGENT_NAMES
    .sort((a, b) => b.length - a.length)
    .map((a) => a.replace(/-/g, '\\-'))
    .join('|')})\\b`,
  'i'
);

function isManualSession(sessionID) {
  return !agentPattern.test(sessionID);
}

// ─── Error classification ─────────────────────────────────────────────────────

function extractStatusCode(error) {
  if (!error) return undefined;
  // ApiError
  if (error.data?.statusCode) return error.data.statusCode;
  // Direct status field
  if (error.status) return error.status;
  if (error.statusCode) return error.statusCode;
  // Try to extract from message
  const match = typeof error.data?.message === 'string'
    ? error.data.message.match(/\b(\d{3})\b/)
    : undefined;
  return match ? parseInt(match[1]) : undefined;
}

function isRetryableError(error, retryOnErrors) {
  if (!error) return false;
  const statusCode = extractStatusCode(error);
  if (statusCode && retryOnErrors.includes(statusCode)) return true;
  // Provider auth errors are not retryable
  if (error.name === 'ProviderAuthError') return false;
  // Abort errors are not retryable  
  if (error.name === 'MessageAbortedError') return false;
  return false;
}

// ─── Model parsing ────────────────────────────────────────────────────────────

function parseModelString(modelStr) {
  if (typeof modelStr !== 'string') return null;
  const idx = modelStr.lastIndexOf('/');
  if (idx === -1 || idx === 0) return null;
  return {
    providerID: modelStr.slice(0, idx),
    modelID: modelStr.slice(idx + 1),
  };
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

const plugin = async (input, options) => {
  const configDir = options?.configDir || join(process.env.HOME || '/root', '.config', 'opencode');
  const config = loadConfig(configDir);

  // Write agent-specific fallback_models to oh-my-openagent.json
  writeAgentFallbacks(configDir, config);

  // Per-session fallback state
  const sessionStates = new Map();

  function getOrCreateSessionState(sessionID) {
    let state = sessionStates.get(sessionID);
    if (!state) {
      state = {
        fallbackIndex: 0,
        attemptCount: 0,
        failedModels: new Map(), // modelName → timestamp
        pending: false,
      };
      sessionStates.set(sessionID, state);
    }
    return state;
  }

  function isModelOnCooldown(modelName, state) {
    const ts = state.failedModels.get(modelName);
    if (!ts) return false;
    return (Date.now() - ts) < config.options.cooldown_seconds * 1000;
  }

  async function tryManualFallback(ctx, sessionID) {
    const state = getOrCreateSessionState(sessionID);

    if (state.pending) return; // already handling
    if (state.attemptCount >= config.options.max_retries) {
      console.log(`[omf] ${sessionID}: max retries (${config.options.max_retries}) reached`);
      sessionStates.delete(sessionID);
      return;
    }

    const models = config.fallback_models.default;
    if (!models || models.length === 0) return;

    // Find next available model (skip cooldown + invalid)
    let nextModel = null;
    while (state.fallbackIndex < models.length) {
      const candidate = models[state.fallbackIndex];
      state.fallbackIndex++;
      if (isModelOnCooldown(candidate, state)) continue;
      if (!parseModelString(candidate)) continue;
      nextModel = candidate;
      break;
    }

    if (!nextModel) {
      console.log(`[omf] ${sessionID}: no available fallback models`);
      sessionStates.delete(sessionID);
      return;
    }

    state.pending = true;
    state.attemptCount++;

    try {
      // 1. Get last user message
      const messagesResp = await ctx.client.session.messages({
        path: { id: sessionID },
        query: { directory: ctx.directory },
      });

      const messages = Array.isArray(messagesResp)
        ? messagesResp
        : messagesResp?.data;

      const lastUserMsg = messages
        ?.filter((m) => m.info?.role === 'user')
        .pop();

      const parts = (lastUserMsg?.parts || lastUserMsg?.info?.parts || [])
        .filter((p) => p.type === 'text' && typeof p.text === 'string' && p.text.length > 0)
        .map((p) => ({ type: 'text', text: p.text }));

      if (parts.length === 0) {
        console.log(`[omf] ${sessionID}: no user message to retry`);
        state.pending = false;
        sessionStates.delete(sessionID);
        return;
      }

      // 2. Abort failed request
      await ctx.client.session.abort({ path: { id: sessionID } });

      // 3. Re-prompt with fallback model
      const parsed = parseModelString(nextModel);
      await ctx.client.session.promptAsync({
        path: { id: sessionID },
        body: {
          model: { providerID: parsed.providerID, modelID: parsed.modelID },
          parts,
        },
        query: { directory: ctx.directory },
      });

      console.log(`[omf] ${sessionID}: fallback → ${nextModel}`);

      // Toast notification
      if (config.options.notify_on_fallback) {
        try {
          // Attempt via client if available; otherwise silently skip
          if (ctx.client.tui?.showToast) {
            await ctx.client.tui.showToast({
              body: {
                title: 'omf: Model Fallback',
                message: `Retrying with ${nextModel}`,
                variant: 'warning',
                duration: 5000,
              },
            });
          }
        } catch { /* toast is best-effort */ }
      }
    } catch (e) {
      console.log(`[omf] ${sessionID}: fallback attempt failed:`, e.message);
      state.failedModels.set(nextModel, Date.now());
      state.pending = false;
      // Try next model recursively
      return tryManualFallback(ctx, sessionID);
    }

    state.pending = false;
  }

  return {
    event: async ({ event }) => {
      if (!config.options.retry_on_errors?.length) return;

      // ── message.updated: catch assistant errors ──────────────────────────
      if (event.type === 'message.updated') {
        const info = event.properties?.info;
        if (!info || info.role !== 'assistant') return;

        const sessionID = info.sessionID;
        if (!sessionID || !isManualSession(sessionID)) return;

        const error = info.error;
        if (!error || !isRetryableError(error, config.options.retry_on_errors)) return;

        console.log(`[omf] ${sessionID}: retryable error detected (${error.name})`);
        await tryManualFallback(input, sessionID);
      }

      // ── session.error: catch session-level errors ────────────────────────
      if (event.type === 'session.error') {
        const props = event.properties;
        if (!props?.sessionID || !isManualSession(props.sessionID)) return;

        const error = props.error;
        if (!error || !isRetryableError(error, config.options.retry_on_errors)) return;

        // Don't immediately retry here — message.updated will fire with more detail.
        // Just mark the session so we're ready.
        getOrCreateSessionState(props.sessionID);
      }
    },
  };
};

export default plugin;
