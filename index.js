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
    default: [
      'opencode/big-pickle',
      'axon/gpt-5.4',
      'axon/claude-sonnet',
      'axon/deepseek',
    ],
    agents: {},
  },
  options: {
    max_retries: 3,
    cooldown_seconds: 30,
    retry_on_errors: [429, 500, 502, 503, 504],
    notify_on_fallback: true,
    auto_optimize: false,
  },
};

// ─── Built-in Model Capability Database ──────────────────────────────────────

const OMO_MODEL_DB = {
  tiers: [
    {
      name: 'premium',
      label: 'Best Reasoning/Coding',
      patterns: [/^opencode\/big-pickle$/, /^axon\/gpt-5/, /axon\/claude-sonnet-4/, /axon\/claude-opus/],
      score: 100,
    },
    {
      name: 'balanced',
      label: 'Balanced Performance',
      patterns: [/^axon\/claude-sonnet(?!-4)/, /^axon\/gpt-4[^.]/, /gpt-4o/, /gemini-pro/, /deepseek-v3/, /deepseek-r1/],
      score: 80,
    },
    {
      name: 'fast',
      label: 'Fast & Cheap',
      patterns: [/claude-haiku/, /gpt-4-mini/, /gpt-4\.1-nano/, /gemini-flash/, /deepseek-chat/, /deepseek-coder/],
      score: 60,
    },
    {
      name: 'cheap',
      label: 'Fallback',
      patterns: [/gpt-3\.5/, /mixtral/, /llama/, /command/, /dbrx/],
      score: 40,
    },
  ],

  classify(modelStr) {
    if (typeof modelStr !== 'string') return null;
    for (const tier of this.tiers) {
      for (const pattern of tier.patterns) {
        if (pattern.test(modelStr)) {
          return { tier: tier.name, score: tier.score, name: tier.label };
        }
      }
    }
    return null;
  },

  rank(models) {
    const categorized = [];
    const unknown = [];

    for (const model of models) {
      const classification = this.classify(model);
      if (classification) {
        categorized.push({ model, ...classification });
      } else {
        unknown.push(model);
      }
    }

    categorized.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.model.localeCompare(b.model);
    });

    return [...categorized.map((c) => c.model), ...unknown];
  },

  optimize(availableModels, maxModels = 6) {
    const unique = [...new Set(availableModels)];
    const ranked = this.rank(unique);
    return ranked.slice(0, maxModels);
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

// ─── Model Discovery & Auto-Optimization ───────────────────────────────────────

function discoverAvailableModels(configDir) {
  const models = new Set();

  const agentConfigPath = join(configDir, 'oh-my-openagent.json');
  if (existsSync(agentConfigPath)) {
    try {
      const raw = readFileSync(agentConfigPath, 'utf-8');
      const agentConfig = JSON.parse(raw);
      const agents = agentConfig.agents || {};

      for (const agent of Object.values(agents)) {
        if (agent.model && typeof agent.model === 'string') {
          models.add(agent.model);
        }
        if (Array.isArray(agent.fallback_models)) {
          for (const model of agent.fallback_models) {
            if (typeof model === 'string') {
              models.add(model);
            }
          }
        }
      }
    } catch (e) {
      console.log(`[omf] Failed to read oh-my-openagent.json: ${e.message}`);
    }
  }

  const opencodeConfigPath = join(configDir, 'opencode.json');
  if (existsSync(opencodeConfigPath)) {
    try {
      const raw = readFileSync(opencodeConfigPath, 'utf-8');
      const opencodeConfig = JSON.parse(raw);

      function extractModels(obj) {
        if (!obj || typeof obj !== 'object') return;
        if (obj.model && typeof obj.model === 'string') {
          models.add(obj.model);
        }
        if (Array.isArray(obj.models)) {
          for (const m of obj.models) {
            if (typeof m === 'string') models.add(m);
            else if (typeof m === 'object' && m.id) models.add(m.id);
          }
        }
        if (Array.isArray(obj.fallback_models)) {
          for (const m of obj.fallback_models) {
            if (typeof m === 'string') models.add(m);
          }
        }
        for (const value of Object.values(obj)) {
          if (value && typeof value === 'object') {
            extractModels(value);
          }
        }
      }

      extractModels(opencodeConfig);
    } catch (e) {
      console.log(`[omf] Failed to read opencode.json: ${e.message}`);
    }
  }

  return [...models];
}

function autoOptimizeConfig(configDir, config) {
  if (!config.options?.auto_optimize) {
    return;
  }

  try {
    const availableModels = discoverAvailableModels(configDir);

    if (availableModels.length === 0) {
      console.log(`[omf] No models found in configs to optimize`);
      return;
    }

    const optimizedChain = OMO_MODEL_DB.optimize(availableModels, 6);
    const currentChain = config.fallback_models?.default || [];

    const currentSorted = [...currentChain].sort().join(',');
    const optimizedSorted = [...optimizedChain].sort().join(',');

    if (currentSorted === optimizedSorted) {
      console.log(`[omf] Auto-optimize: fallback chain unchanged`);
      return;
    }

    config.fallback_models.default = optimizedChain;
    console.log(`[omf] Auto-optimized fallback chain: [${optimizedChain.join(', ')}]`);

    const configPath = join(configDir, 'omf.json');
    if (existsSync(configPath)) {
      try {
        writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
        console.log(`[omf] Saved optimized config to omf.json`);
      } catch (e) {
        console.error(`[omf] Failed to write optimized config: ${e.message}`);
      }
    }
  } catch (e) {
    console.error(`[omf] Auto-optimization failed: ${e.message}`);
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
  if (error.data?.statusCode) return error.data.statusCode;
  if (error.status) return error.status;
  if (error.statusCode) return error.statusCode;
  const match = typeof error.data?.message === 'string'
    ? error.data.message.match(/\b(\d{3})\b/)
    : undefined;
  return match ? parseInt(match[1]) : undefined;
}

function isRetryableError(error, retryOnErrors) {
  if (!error) return false;
  const statusCode = extractStatusCode(error);
  if (statusCode && retryOnErrors.includes(statusCode)) return true;
  if (error.name === 'ProviderAuthError') return false;
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

  writeAgentFallbacks(configDir, config);

  autoOptimizeConfig(configDir, config);

  const sessionStates = new Map();

  function getOrCreateSessionState(sessionID) {
    let state = sessionStates.get(sessionID);
    if (!state) {
      state = {
        fallbackIndex: 0,
        attemptCount: 0,
        failedModels: new Map(),
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

    if (state.pending) return;
    if (state.attemptCount >= config.options.max_retries) {
      console.log(`[omf] ${sessionID}: max retries (${config.options.max_retries}) reached`);
      sessionStates.delete(sessionID);
      return;
    }

    const models = config.fallback_models.default;
    if (!models || models.length === 0) return;

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

      await ctx.client.session.abort({ path: { id: sessionID } });

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

      if (config.options.notify_on_fallback) {
        try {
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
      return tryManualFallback(ctx, sessionID);
    }

    state.pending = false;
  }

  return {
    event: async ({ event }) => {
      if (!config.options.retry_on_errors?.length) return;

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

      if (event.type === 'session.error') {
        const props = event.properties;
        if (!props?.sessionID || !isManualSession(props.sessionID)) return;

        const error = props.error;
        if (!error || !isRetryableError(error, config.options.retry_on_errors)) return;

        getOrCreateSessionState(props.sessionID);
      }
    },
  };
};

export { OMO_MODEL_DB, discoverAvailableModels };
export default plugin;