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
 *   Create omf.json in the OpenCode config dir (platform-adaptive:
 *     %APPDATA%/opencode/ on Windows, ~/.config/opencode/ on Linux/macOS)
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Cross-platform config path resolution ────────────────────────────────────

function getOpenCodeConfigDir() {
  // Windows: %APPDATA%\opencode\
  // Linux/macOS: $XDG_CONFIG_HOME/opencode or ~/.config/opencode
  if (process.env.APPDATA) {
    return join(process.env.APPDATA, 'opencode');
  }
  if (process.env.XDG_CONFIG_HOME) {
    return join(process.env.XDG_CONFIG_HOME, 'opencode');
  }
  return join(process.env.HOME || '/root', '.config', 'opencode');
}

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
    detect: {
      empty: true,
      refusal: true,
      usage_limit: true,
      truncated: false,
      custom_patterns: [],
    },
    health_check: true,
    provider_cooldown_seconds: 60,
  },
  evolve: {
    enabled: true,
    min_observations: 5,
    promote_threshold: 0.7,
    demote_threshold: 0.3,
    max_chain_size: 6,
    new_model_behavior: 'append',
  },
};

// ─── Built-in Model Capability Database ──────────────────────────────────────

const OMO_MODEL_DB = {
  tiers: [
    {
      name: 'premium',
      label: 'Best Reasoning/Coding',
      patterns: [
        /^opencode\/big-pickle$/,
        /^axon\/gpt-5/,
        /axon\/claude-sonnet-4/,
        /axon\/claude-opus/,
        /nvidia\/z-ai\/glm-5\.1/,
      ],
      score: 100,
    },
    {
      name: 'balanced',
      label: 'Balanced Performance',
      patterns: [
        /^axon\/claude-sonnet(?!-4)/,
        /^axon\/gpt-4[^.]/,
        /gpt-4o/,
        /gemini-pro/,
        /deepseek-v3/,
        /deepseek-r1/,
        /axon\/glm-5\b/,
        /axon\/gemini\b/,
        /axon\/deepseek\b/,
        /nvidia\/z-ai\//,
        /nvidia\/qwen\/qwen3-[0-9]+b/,
        /nvidia\/nvidia\/llama-3\.[13]-nemotron-ultra/,
      ],
      score: 80,
    },
    {
      name: 'fast',
      label: 'Fast & Cheap',
      patterns: [
        /claude-haiku/,
        /gpt-4-mini/,
        /gpt-4\.1-nano/,
        /gemini-flash/,
        /deepseek-chat/,
        /deepseek-coder/,
        /axon\/glm-4\./,
        /axon\/flash\b/,
        /axon\/kimi\b/,
        /axon\/qwen\b/,
        /axon\/MiniMax/,
        /grok-.*fast/,
        /axon\/coder\b/,
        /nvidia\/minimaxai\//,
        /nvidia\/moonshotai\//,
        /nvidia\/qwen\/qwen3-coder/,
        /nvidia\/qwen\/qwen3\.5/,
      ],
      score: 60,
    },
    {
      name: 'cheap',
      label: 'Fallback',
      patterns: [
        /gpt-3\.5/,
        /mixtral/,
        /llama/,
        /command/,
        /dbrx/,
        /axon\/glm-4\.7/,
        /axon\/grok-4\b/,
      ],
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

// ─── Self-Evolution Engine ────────────────────────────────────────────────────
// Tracks model call outcomes (success/failure/latency), analyzes performance,
// and automatically re-orders the fallback chain. Inspired by skill-evolver's
// trace-driven diagnosis + data-gated iteration loop.

const EVOLVE_DEFAULTS = {
  enabled: true,
  min_observations: 5,
  promote_threshold: 0.7,
  demote_threshold: 0.3,
  max_chain_size: 6,
  new_model_behavior: 'append',
};

function getEvolveLogPath(configDir) {
  return join(configDir, 'evolve.jsonl');
}

function logModelOutcome(configDir, modelName, success, latencyMs, errorCode) {
  const logPath = getEvolveLogPath(configDir);
  const entry = {
    t: Date.now(),
    m: modelName,
    s: success ? 1 : 0,
    l: latencyMs || 0,
    e: errorCode || null,
  };
  try {
    appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf-8');
  } catch (e) {
    console.log(`[omf] Failed to log evolve entry: ${e.message}`);
  }
}

function analyzeModelPerformance(configDir, minObservations) {
  const logPath = getEvolveLogPath(configDir);
  if (!existsSync(logPath)) return [];

  try {
    const raw = readFileSync(logPath, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);

    const stats = {};
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const m = entry.m;
        if (!stats[m]) {
          stats[m] = { successes: 0, failures: 0, totalLatency: 0, count: 0, lastError: null };
        }
        if (entry.s) stats[m].successes++;
        else { stats[m].failures++; stats[m].lastError = entry.e; }
        stats[m].totalLatency += entry.l || 0;
        stats[m].count++;
      } catch { /* skip malformed lines */ }
    }

    return Object.entries(stats)
      .filter(([_, s]) => s.count >= minObservations)
      .map(([model, s]) => ({
        model,
        successRate: s.successes / s.count,
        avgLatency: s.count > 0 ? s.totalLatency / s.count : 0,
        totalCalls: s.count,
        lastError: s.lastError,
      }))
      .sort((a, b) => {
        if (b.successRate !== a.successRate) return b.successRate - a.successRate;
        return a.avgLatency - b.avgLatency;
      });
  } catch (e) {
    console.log(`[omf] Evolution analysis failed: ${e.message}`);
    return [];
  }
}

function discoverNewModels(knownModels, configDir) {
  try {
    const allModels = discoverAvailableModels(configDir);
    return allModels.filter(m => !knownModels.includes(m));
  } catch {
    return [];
  }
}

function discoverAgentEntries(configDir) {
  const entries = {};
  const agentConfigPath = join(configDir, 'oh-my-openagent.json');
  if (!existsSync(agentConfigPath)) return entries;

  try {
    const raw = readFileSync(agentConfigPath, 'utf-8');
    const agentConfig = JSON.parse(raw);

    if (agentConfig.agents) {
      for (const [name, entry] of Object.entries(agentConfig.agents)) {
        entries[name] = {
          model: entry.model || null,
          fallback_models: entry.fallback_models || [],
          type: 'agent',
        };
      }
    }

    if (agentConfig.categories) {
      for (const [name, entry] of Object.entries(agentConfig.categories)) {
        entries[`[category] ${name}`] = {
          model: entry.model || null,
          fallback_models: entry.fallback_models || [],
          type: 'category',
          rawName: name,
        };
      }
    }
  } catch (e) {
    console.log(`[omf] Failed to read agent entries: ${e.message}`);
  }

  return entries;
}

function evolveFallbackChain(configDir, config) {
  const evolveOpts = { ...EVOLVE_DEFAULTS, ...(config.evolve || {}) };
  if (!evolveOpts.enabled) return false;

  const currentChain = config.fallback_models?.default || [];
  if (currentChain.length === 0) return false;

  const performance = analyzeModelPerformance(configDir, evolveOpts.min_observations);

  const promoteSet = new Set();
  const demoteSet = new Set();

  for (const p of performance) {
    if (p.successRate >= evolveOpts.promote_threshold) promoteSet.add(p.model);
    else if (p.successRate <= evolveOpts.demote_threshold) demoteSet.add(p.model);
  }

  const perfByModel = {};
  for (const p of performance) perfByModel[p.model] = p;

  const promoted = currentChain.filter(m => promoteSet.has(m));
  const demoted = currentChain.filter(m => demoteSet.has(m));
  const unchanged = currentChain.filter(m => !promoteSet.has(m) && !demoteSet.has(m));

  promoted.sort((a, b) => (perfByModel[b]?.successRate || 0) - (perfByModel[a]?.successRate || 0));

  let newModels = [];
  if (evolveOpts.new_model_behavior === 'append') {
    newModels = discoverNewModels(currentChain, configDir);
    if (newModels.length > 0) {
      console.log(`[omf] Discovered new model(s): ${newModels.join(', ')}`);
    }
  }

  let finalChain = [...promoted, ...unchanged, ...demoted, ...newModels];
  if (finalChain.length > evolveOpts.max_chain_size) {
    finalChain = finalChain.slice(0, evolveOpts.max_chain_size);
  }

  if (finalChain.join(',') !== currentChain.join(',')) {
    config.fallback_models.default = finalChain;
    console.log(`[omf] Evolved fallback chain: [${finalChain.join(', ')}]`);

    const configPath = join(configDir, 'omf.json');
    try {
      writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
      console.log(`[omf] Saved evolved config to omf.json`);
    } catch (e) {
      console.error(`[omf] Failed to save evolved config: ${e.message}`);
    }
    return true;
  }

  return false;
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

const REFUSAL_PATTERNS = [
  /^I('m| am) (sorry|afraid)[,\.\s]/i,
  /^(Sorry|I apologize)[,\.\s]/i,
  /^I cannot (fulfill|complete|process|answer|provide)/i,
  /^I('m| am) not (able|designed|equipped) to/i,
  /^As an AI (assistant|language model)/i,
  /(rate|usage|free|额度).*(limit|exceeded|quota|失败|不足)/i,
  /(limit|quota|额度|余额).*(exceeded|reached|失败|不足|耗尽)/i,
  /insufficient.*(quota|balance|credit|额度|余额)/i,
];

function isUsageLimitResponse(text) {
  return /(rate|usage|free|额度).*(limit|exceeded|quota|失败|不足)/i.test(text) ||
    /(limit|quota|额度|余额).*(exceeded|reached|失败|不足|耗尽)/i.test(text) ||
    /insufficient.*(quota|balance|credit|额度|余额)/i.test(text);
}

function isAbnormalResponse(messageInfo, detectConfig) {
  if (!detectConfig || !messageInfo) return null;
  const parts = messageInfo.parts || [];
  const text = parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text || '')
    .join('');

  if (detectConfig.empty && (!text || text.trim().length === 0)) {
    return { reason: 'empty', detail: 'empty response' };
  }

  if (detectConfig.refusal || detectConfig.usage_limit) {
    const trimmed = text.trim();
    if (isUsageLimitResponse(trimmed)) {
      return { reason: 'usage_limit', detail: 'usage limit / quota exceeded' };
    }
  }

  if (detectConfig.refusal) {
    for (const pattern of REFUSAL_PATTERNS) {
      if (pattern.test(text.trim())) {
        return { reason: 'refusal', detail: `matches refusal pattern` };
      }
    }
  }

  // Custom user-defined failure patterns
  if (Array.isArray(detectConfig.custom_patterns) && detectConfig.custom_patterns.length > 0) {
    const trimmed = text.trim();
    for (const pat of detectConfig.custom_patterns) {
      try {
        const re = new RegExp(pat, 'i');
        if (re.test(trimmed)) {
          return { reason: 'custom', detail: `matches custom pattern: ${pat}` };
        }
      } catch { /* skip invalid regex */ }
    }
  }

  return null;
}

function getRecentModelHealth(configDir, modelName, maxEntries = 3) {
  const logPath = getEvolveLogPath(configDir);
  if (!existsSync(logPath)) return null;

  try {
    const raw = readFileSync(logPath, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);
    const recent = [];
    for (let i = lines.length - 1; i >= 0 && recent.length < maxEntries; i--) {
      const entry = JSON.parse(lines[i]);
      if (entry.m === modelName) recent.push(entry);
    }
    if (recent.length === 0) return null;
    const failures = recent.filter((e) => !e.s).length;
    return { total: recent.length, failures, successRate: (recent.length - failures) / recent.length };
  } catch {
    return null;
  }
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
  const configDir = options?.configDir || getOpenCodeConfigDir();
  const config = loadConfig(configDir);

  writeAgentFallbacks(configDir, config);

  autoOptimizeConfig(configDir, config);
  evolveFallbackChain(configDir, config);

  const sessionStates = new Map();

  function getOrCreateSessionState(sessionID) {
    let state = sessionStates.get(sessionID);
    if (!state) {
      state = {
        fallbackIndex: 0,
        attemptCount: 0,
        failedModels: new Map(),
        failedProviders: new Map(),
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

    const providerCooldown = (config.options.provider_cooldown_seconds || 60) * 1000;

    let nextModel = null;
    while (state.fallbackIndex < models.length) {
      const candidate = models[state.fallbackIndex];
      state.fallbackIndex++;

      // Skip models on per-model cooldown
      if (isModelOnCooldown(candidate, state)) continue;

      const parsed = parseModelString(candidate);
      if (!parsed) continue;

      // Provider circuit breaker
      const providerTs = state.failedProviders.get(parsed.providerID);
      if (providerTs && (Date.now() - providerTs) < providerCooldown) {
        console.log(`[omf] Skipping ${candidate}: provider ${parsed.providerID} on circuit breaker`);
        continue;
      }

      // Health check from evolve data
      if (config.options.health_check !== false) {
        const health = getRecentModelHealth(configDir, candidate, 3);
        if (health && health.failures >= 2 && health.total >= 2) {
          console.log(`[omf] Skipping ${candidate}: recent health (${health.failures}/${health.total} failures)`);
          state.failedModels.set(candidate, Date.now());
          continue;
        }
      }

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
    const fallbackStartTime = Date.now();

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

      logModelOutcome(configDir, nextModel, true, Date.now() - fallbackStartTime);
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
      logModelOutcome(configDir, nextModel, false, Date.now() - fallbackStartTime, extractStatusCode(e));
      console.log(`[omf] ${sessionID}: fallback attempt failed:`, e.message);
      state.failedModels.set(nextModel, Date.now());
      const failParsed = parseModelString(nextModel);
      if (failParsed) state.failedProviders.set(failParsed.providerID, Date.now());
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

        // 1. Explicit error detection (status codes, provider errors)
        const error = info.error;
        if (error && isRetryableError(error, config.options.retry_on_errors)) {
          console.log(`[omf] ${sessionID}: retryable error detected (${error.name})`);
          await tryManualFallback(input, sessionID);
          return;
        }

        // 2. Abnormal response detection (empty, refusal, usage limit)
        if (!error) {
          const detectConfig = config.options.detect;
          const abnormal = isAbnormalResponse(info, detectConfig);
          if (abnormal) {
            console.log(`[omf] ${sessionID}: abnormal response (${abnormal.reason}) — ${abnormal.detail}`);
            await tryManualFallback(input, sessionID);
            return;
          }
        }
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

// ─── TUI Configuration via OpenCode command ─────────────────────────────────

function readLine(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function showStatus(config) {
  console.log(`\n[omf] Current fallback chain:`);
  (config.fallback_models?.default || []).forEach((m, i) => {
    const cls = OMO_MODEL_DB.classify(m);
    const label = cls ? ` (${cls.name})` : '';
    console.log(`[omf]   ${i + 1}) ${m}${label}`);
  });

  const agents = config.fallback_models?.agents || {};
  if (Object.keys(agents).length > 0) {
    console.log(`[omf] Per-agent overrides:`);
    for (const [agent, models] of Object.entries(agents)) {
      console.log(`[omf]   ${agent}: ${models.join(', ')}`);
    }
  }

  const detect = config.options?.detect || {};
  const detectEnabled = Object.entries(detect)
    .filter(([k, v]) => k !== 'truncated' && v)
    .map(([k]) => k)
    .join(', ');
  const healthCheck = config.options?.health_check !== false;
  const providerCD = config.options?.provider_cooldown_seconds || 60;
  console.log(`[omf] Options: max_retries=${config.options?.max_retries}, ` +
    `cooldown=${config.options?.cooldown_seconds}s, ` +
    `auto_optimize=${config.options?.auto_optimize}` +
    ` | detect=[${detectEnabled}]` +
    ` | health_check=${healthCheck}` +
    ` | provider_cd=${providerCD}s`);

  const evolve = config.evolve || {};
  console.log(`[omf] Evolve: ${evolve.enabled ? 'enabled' : 'disabled'}` +
    (evolve.enabled ? ` (min_obs=${evolve.min_observations}, promote≥${evolve.promote_threshold}, demote≤${evolve.demote_threshold}, max_chain=${evolve.max_chain_size})` : ''));
}

async function tuiAutoOptimize(configDir, config) {
  console.log(`[omf] Scanning for available models...`);
  const models = discoverAvailableModels(configDir);
  if (models.length === 0) {
    console.log(`[omf] No models found in config files.`);
    return false;
  }
  console.log(`[omf] Discovered ${models.length} model(s): ${models.join(', ')}`);
  const optimized = OMO_MODEL_DB.optimize(models, 6);
  console.log(`[omf] Optimized chain: ${optimized.join(' → ')}`);
  const ok = await readLine(`[omf] Apply this chain? (y/n): `);
  if (ok.toLowerCase() === 'y') {
    config.fallback_models.default = optimized;
    const configPath = join(configDir, 'omf.json');
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    console.log(`[omf] Config saved to ${configPath}`);
    return true;
  }
  return false;
}

async function tuiManualChain(configDir, config) {
  console.log(`[omf] Enter models for the fallback chain, one per line.`);
  console.log(`[omf] Format: provider/model (e.g., opencode/big-pickle)`);
  console.log(`[omf] Type 'done' when finished, 'list' to see discovered models.\n`);

  const newChain = [];
  while (true) {
    const line = await readLine(`[omf] model #${newChain.length + 1}> `);
    const input = line.trim();
    if (input.toLowerCase() === 'done') break;
    if (input.toLowerCase() === 'list') {
      const models = discoverAvailableModels(configDir);
      if (models.length === 0) {
        console.log(`[omf] No models discovered from configs.`);
      } else {
        models.forEach((m) => {
          const cls = OMO_MODEL_DB.classify(m);
          const label = cls ? ` (${cls.name})` : '';
          console.log(`[omf]   ${m}${label}`);
        });
      }
      continue;
    }
    if (input.includes('/')) {
      newChain.push(input);
      console.log(`[omf]   Added: ${input}`);
    } else {
      console.log(`[omf]   Invalid format. Use provider/model`);
    }
  }

  if (newChain.length === 0) {
    console.log(`[omf] Chain unchanged.`);
    return false;
  }

  console.log(`\n[omf] New fallback chain:`);
  newChain.forEach((m, i) => console.log(`[omf]   ${i + 1}) ${m}`));
  const ok = await readLine(`\n[omf] Apply? (y/n): `);
  if (ok.toLowerCase() === 'y') {
    config.fallback_models.default = newChain;
    const configPath = join(configDir, 'omf.json');
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    console.log(`[omf] Config saved to ${configPath}`);
    return true;
  }
  return false;
}

async function tuiEditOptions(configDir, config) {
  console.log(`[omf] Current options:`);
  console.log(`[omf]   1) max_retries: ${config.options?.max_retries}`);
  console.log(`[omf]   2) cooldown_seconds: ${config.options?.cooldown_seconds}`);
  console.log(`[omf]   3) auto_optimize: ${config.options?.auto_optimize}`);
  const detect = config.options?.detect || {};
  const hc = config.options?.health_check !== false;
  const pcd = config.options?.provider_cooldown_seconds || 60;
  const detFlags = `empty=${detect.empty}|refuse=${detect.refusal}|limit=${detect.usage_limit}`;
  console.log(`[omf]   4) notify_on_fallback: ${config.options?.notify_on_fallback}`);
  console.log(`[omf]   5) detect: ${detFlags}`);
  console.log(`[omf]   6) health_check: ${hc}`);
  console.log(`[omf]   7) provider_cooldown: ${pcd}s`);
  const evolve = config.evolve || {};
  console.log(`[omf]   8) evolve: ${evolve.enabled ? 'enabled' : 'disabled'}`);
  console.log(`[omf]   0) Back\n`);

  const choice = await readLine(`[omf] Edit which option? (0-8): `);
  switch (choice.trim()) {
    case '1': {
      const val = await readLine(`[omf] max_retries (current: ${config.options?.max_retries}): `);
      const n = parseInt(val);
      if (n > 0) config.options.max_retries = n;
      break;
    }
    case '2': {
      const val = await readLine(`[omf] cooldown_seconds (current: ${config.options?.cooldown_seconds}): `);
      const n = parseInt(val);
      if (n > 0) config.options.cooldown_seconds = n;
      break;
    }
    case '3': {
      const val = await readLine(`[omf] auto_optimize (true/false, current: ${config.options?.auto_optimize}): `);
      if (val === 'true') config.options.auto_optimize = true;
      if (val === 'false') config.options.auto_optimize = false;
      break;
    }
    case '4': {
      const val = await readLine(`[omf] notify_on_fallback (true/false, current: ${config.options?.notify_on_fallback}): `);
      if (val === 'true') config.options.notify_on_fallback = true;
      if (val === 'false') config.options.notify_on_fallback = false;
      break;
    }
    case '5': {
      const d = config.options.detect || {};
      const toggle = await readLine(`[omf] toggle detect (empty/refusal/usage_limit/custom), current: empty=${d.empty}, refusal=${d.refusal}, usage_limit=${d.usage_limit}, custom_patterns=${(d.custom_patterns||[]).length} patterns: `);
      const t = toggle.trim().toLowerCase();
      if (t === 'empty') config.options.detect = { ...d, empty: !d.empty };
      else if (t === 'refusal') config.options.detect = { ...d, refusal: !d.refusal };
      else if (t === 'usage_limit' || t === 'limit') config.options.detect = { ...d, usage_limit: !d.usage_limit };
      else if (t === 'custom') {
        const pat = await readLine(`[omf] add custom pattern (regex string, e.g. "预扣费|余额不足"): `);
        if (pat.trim()) {
          const arr = d.custom_patterns || [];
          arr.push(pat.trim());
          config.options.detect = { ...d, custom_patterns: arr };
        }
      }
      break;
    }
    case '6': {
      config.options.health_check = !config.options.health_check;
      if (config.options.health_check === undefined) config.options.health_check = true;
      console.log(`[omf] health_check set to: ${config.options.health_check}`);
      break;
    }
    case '7': {
      const val = await readLine(`[omf] provider_cooldown_seconds (current: ${pcd}): `);
      const n = parseInt(val);
      if (n > 0) config.options.provider_cooldown_seconds = n;
      break;
    }
    case '8': {
      const val = await readLine(`[omf] evolve (true/false, current: ${config.evolve?.enabled}): `);
      if (val === 'true' || val === 'on') {
        config.evolve = { ...EVOLVE_DEFAULTS, ...(config.evolve || {}), enabled: true };
      } else if (val === 'false' || val === 'off') {
        config.evolve = { ...EVOLVE_DEFAULTS, ...(config.evolve || {}), enabled: false };
      }
      break;
    }
    case '0': return false;
    default: console.log(`[omf] Invalid choice.`); return false;
  }

  const configPath = join(configDir, 'omf.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  console.log(`[omf] Options updated.`);
  return true;
}

// ─── Init: Discover & Configure ─────────────────────────────────────────────

async function tuiInit(configDir, config) {
  console.log(`\n[omf] ═══ omf Init — Discover & Configure ═══`);

  // 1. Discover provider models from opencode.json
  const providerModels = discoverProviderModels(configDir);
  console.log(`\n[omf] Provider models (from opencode.json providers):`);
  if (providerModels.length === 0) {
    console.log(`[omf]   (none found)`);
  } else {
    const ranked = OMO_MODEL_DB.rank(providerModels);
    ranked.forEach((m, i) => {
      const cls = OMO_MODEL_DB.classify(m);
      const label = cls ? ` (${cls.name})` : '';
      console.log(`[omf]   ${i + 1}) ${m}${label}`);
    });
  }

  // 2. All available models across all configs
  const allModels = discoverAvailableModels(configDir);
  console.log(`\n[omf] All available models (${allModels.length} total):`);
  const allRanked = OMO_MODEL_DB.rank(allModels);
  allRanked.forEach((m, i) => {
    const cls = OMO_MODEL_DB.classify(m);
    const label = cls ? ` (${cls.name})` : ' (unclassified)';
    console.log(`[omf]   ${i + 1}) ${m}${label}`);
  });

  // 3. Discover agents & categories
  const agentEntries = discoverAgentEntries(configDir);
  const agentKeys = Object.keys(agentEntries);
  console.log(`\n[omf] Agents / Categories (${agentKeys.length} total):`);
  if (agentKeys.length === 0) {
    console.log(`[omf]   (none found — oh-my-openagent.json not configured)`);
  } else {
    agentKeys.sort().forEach((name) => {
      const entry = agentEntries[name];
      const modelLabel = entry.model || '(no primary model)';
      console.log(`[omf]   ${name}`);
      console.log(`[omf]     primary: ${modelLabel}`);
      if (entry.fallback_models.length > 0) {
        console.log(`[omf]     current fallbacks (${entry.fallback_models.length}): [${entry.fallback_models.slice(0, 3).join(', ')}${entry.fallback_models.length > 3 ? '...' : ''}]`);
      }
    });
  }

  // 4. Propose optimized default chain
  const optimizedDefault = OMO_MODEL_DB.optimize(allModels, 6);
  console.log(`\n[omf] Proposed default fallback chain (${optimizedDefault.length} models):`);
  optimizedDefault.forEach((m, i) => {
    const cls = OMO_MODEL_DB.classify(m);
    const label = cls ? ` (${cls.name})` : '';
    console.log(`[omf]   ${i + 1}) ${m}${label}`);
  });

  // 5. Propose per-agent/category chains
  const proposedAgentChains = {};
  for (const [name, entry] of Object.entries(agentEntries)) {
    const pool = entry.model
      ? [entry.model, ...allModels.filter(m => m !== entry.model)]
      : allModels;
    const chain = OMO_MODEL_DB.optimize(pool, 6);
    proposedAgentChains[name] = chain;
  }

  // Show a few key agents
  const agentOnlyKeys = agentKeys.filter(k => agentEntries[k].type === 'agent').sort();
  if (agentOnlyKeys.length > 0) {
    console.log(`\n[omf] Proposed per-agent fallback chains (showing first 3):`);
    agentOnlyKeys.slice(0, 3).forEach((name) => {
      console.log(`[omf]   ${name}: [${proposedAgentChains[name].join(', ')}]`);
    });
    if (agentOnlyKeys.length > 3) {
      console.log(`[omf]   ... and ${agentOnlyKeys.length - 3} more agent(s)`);
    }
  }

  // 6. Confirm
  console.log(``);
  const ok = await readLine(`[omf] Apply proposed configuration? (y/n/detail): `);
  const answer = ok.trim().toLowerCase();

  if (answer === 'y' || answer === 'yes') {
    // Apply default chain
    config.fallback_models.default = optimizedDefault;

    // Apply per-agent chains
    for (const [name, chain] of Object.entries(proposedAgentChains)) {
      const entry = agentEntries[name];
      if (entry.type === 'category') {
        config.fallback_models.agents[entry.rawName] = chain;
      } else {
        config.fallback_models.agents[name] = chain;
      }
    }

    // Save
    const configPath = join(configDir, 'omf.json');
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    console.log(`[omf] Config saved to ${configPath}`);

    // Write agent fallbacks to oh-my-openagent.json
    writeAgentFallbacks(configDir, config);

    console.log(`[omf] Init complete. Restart OpenCode for changes to take effect.`);
    return true;
  }

  if (answer === 'detail') {
    // Show full per-agent proposal and ask individually
    console.log(`\n[omf] Full per-agent proposal:`);
    let idx = 1;
    const allNames = agentKeys.sort();
    for (const name of allNames) {
      console.log(`[omf]   ${idx}) ${name}`);
      console.log(`[omf]      chain: [${proposedAgentChains[name].join(', ')}]`);
      const current = agentEntries[name].fallback_models || [];
      if (current.length > 0) {
        console.log(`[omf]      current: [${current.join(', ')}]`);
      }
      idx++;
    }
    console.log(`[omf]   ${idx}) default chain`);
    console.log(`[omf]      chain: [${optimizedDefault.join(', ')}]`);

    const sel = await readLine(`\n[omf] Enter number to customize, or 'apply' to apply all: `);
    if (sel.trim() === 'apply') {
      config.fallback_models.default = optimizedDefault;
      for (const [name, chain] of Object.entries(proposedAgentChains)) {
        const entry = agentEntries[name];
        if (entry.type === 'category') {
          config.fallback_models.agents[entry.rawName] = chain;
        } else {
          config.fallback_models.agents[name] = chain;
        }
      }
      const configPath = join(configDir, 'omf.json');
      writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
      writeAgentFallbacks(configDir, config);
      console.log(`[omf] Init complete.`);
      return true;
    }
    console.log(`[omf] Init cancelled.`);
    return false;
  }

  console.log(`[omf] Init cancelled.`);
  return false;
}

function discoverProviderModels(configDir) {
  const models = new Set();
  const opencodeConfigPath = join(configDir, 'opencode.json');
  if (!existsSync(opencodeConfigPath)) return [];

  try {
    const raw = readFileSync(opencodeConfigPath, 'utf-8');
    const config = JSON.parse(raw);
    const providers = config.provider || {};

    for (const [providerName, providerConfig] of Object.entries(providers)) {
      if (providerConfig.models && typeof providerConfig.models === 'object') {
        for (const modelKey of Object.keys(providerConfig.models)) {
          models.add(`${providerName}/${modelKey}`);
        }
      }
    }
  } catch (e) {
    console.log(`[omf] Failed to read provider models: ${e.message}`);
  }

  return [...models];
}

async function runTUI(configDir) {
  const config = loadConfig(configDir);

  while (true) {
    console.log(`\n[omf] ═══ omf Configuration ═══`);
    console.log(`[omf]  1) Show status`);
    console.log(`[omf]  2) Auto-optimize fallback chain`);
    console.log(`[omf]  3) Manually set fallback chain`);
    console.log(`[omf]  4) Edit options`);
    console.log(`[omf]  5) Init — discover & configure all agents and models`);
    console.log(`[omf]  0) Exit`);

    const choice = await readLine(`[omf] Select (0-5): `);
    switch (choice.trim()) {
      case '1': await showStatus(config); break;
      case '2': await tuiAutoOptimize(configDir, config); break;
      case '3': await tuiManualChain(configDir, config); break;
      case '4': await tuiEditOptions(configDir, config); break;
      case '5': await tuiInit(configDir, config); break;
      case '0':
        console.log(`[omf] Exiting.`);
        return;
      default:
        console.log(`[omf] Invalid choice.`);
    }
  }
}

// ─── Command handler for /omf ──────────────────────────────────────────────

async function handleCommand({ name, args }) {
  if (name === 'omf') {
    const sub = (args && args[0]) || 'menu';
    switch (sub) {
      case 'status':
      case 'show': {
        const configDir = getOpenCodeConfigDir();
        const config = loadConfig(configDir);
        await showStatus(config);
        break;
      }
      case 'optimize':
      case 'auto': {
        const configDir = getOpenCodeConfigDir();
        const config = loadConfig(configDir);
        await tuiAutoOptimize(configDir, config);
        break;
      }
      case 'chain':
      case 'manual': {
        const configDir = getOpenCodeConfigDir();
        const config = loadConfig(configDir);
        await tuiManualChain(configDir, config);
        break;
      }
      case 'options': {
        const configDir = getOpenCodeConfigDir();
        const config = loadConfig(configDir);
        await tuiEditOptions(configDir, config);
        break;
      }
      case 'init':
      case 'setup': {
        const configDir = getOpenCodeConfigDir();
        const config = loadConfig(configDir);
        await tuiInit(configDir, config);
        break;
      }
      case 'evolve': {
        const configDir = getOpenCodeConfigDir();
        const config = loadConfig(configDir);
        const evolveSub = args[1];
        if (evolveSub === 'on' || evolveSub === 'enable') {
          config.evolve = { ...EVOLVE_DEFAULTS, ...(config.evolve || {}), enabled: true };
          const configPath = join(configDir, 'omf.json');
          writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
          console.log(`[omf] Self-evolution enabled.`);
          console.log(`[omf] Next plugin load will analyze performance data and adjust the fallback chain.`);
        } else if (evolveSub === 'off' || evolveSub === 'disable') {
          config.evolve = { ...EVOLVE_DEFAULTS, ...(config.evolve || {}), enabled: false };
          const configPath = join(configDir, 'omf.json');
          writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
          console.log(`[omf] Self-evolution disabled.`);
        } else if (evolveSub === 'status') {
          const evolveOpts = { ...EVOLVE_DEFAULTS, ...(config.evolve || {}) };
          console.log(`\n[omf] Evolve: ${evolveOpts.enabled ? 'enabled' : 'disabled'}`);
          if (evolveOpts.enabled) {
            console.log(`[omf]   min_observations: ${evolveOpts.min_observations}`);
            console.log(`[omf]   promote_threshold: ${evolveOpts.promote_threshold}`);
            console.log(`[omf]   demote_threshold: ${evolveOpts.demote_threshold}`);
            console.log(`[omf]   max_chain_size: ${evolveOpts.max_chain_size}`);
            console.log(`[omf]   new_model_behavior: ${evolveOpts.new_model_behavior}`);
            const performance = analyzeModelPerformance(configDir, 0);
            if (performance.length > 0) {
              console.log(`[omf] Model Performance:`);
              for (const p of performance) {
                const rate = (p.successRate * 100).toFixed(0);
                const lat = (p.avgLatency / 1000).toFixed(1);
                console.log(`[omf]   ${p.model}  success: ${rate}% (${p.totalCalls} calls, avg ${lat}s)`);
              }
            } else {
              console.log(`[omf] No performance data yet. Use fallback models to collect data.`);
            }
          }
        } else if (evolveSub === 'reset') {
          const logPath = getEvolveLogPath(configDir);
          try {
            writeFileSync(logPath, '', 'utf-8');
            console.log(`[omf] Evolution data cleared.`);
          } catch (e) {
            console.error(`[omf] Failed to clear evolve data: ${e.message}`);
          }
        } else {
          console.log(`[omf] Evolve subcommands:`);
          console.log(`[omf]   /omf evolve on       Enable self-evolution`);
          console.log(`[omf]   /omf evolve off      Disable self-evolution`);
          console.log(`[omf]   /omf evolve status   Show evolution stats & model performance`);
          console.log(`[omf]   /omf evolve reset    Clear evolution data`);
        }
        break;
      }
      default: {
        const configDir = getOpenCodeConfigDir();
        await runTUI(configDir);
        break;
      }
    }
    return { handled: true };
  }
  return { handled: false };
}

export {
  OMO_MODEL_DB,
  discoverAvailableModels,
  discoverAgentEntries,
  discoverProviderModels,
  runTUI,
  tuiInit,
  handleCommand,
  EVOLVE_DEFAULTS,
  getEvolveLogPath,
  logModelOutcome,
  analyzeModelPerformance,
  discoverNewModels,
  evolveFallbackChain,
};
export default plugin;