/**
 * omf (oh-my-fallback) — OpenCode plugin for unified model fallback management.
 *
 * Handles fallback for ALL session types (manual + agent):
 *   Detects failed model responses (errors, empty/refusal/usage-limit content)
 *   and automatically re-prompts with the next model in the fallback chain.
 *
 * Fallback chain is read from omf.json only — no coupling with
 * oh-my-openagent.json or other plugins.
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
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Plugin context stored at module level so handleCommand/tuiInit/runInit can use it
let _pluginCtx = null;

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
  },
  options: {
    max_retries: 3,
    cooldown_seconds: 30,
    retry_on_errors: [404, 410, 429, 500, 502, 503, 504],
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
    server_url: 'http://127.0.0.1:4096',
    weights: {
      enabled: true,
      success_rate: 70,
      latency: 30,
      min_observations: 3,
    },
  },
  model_tiers: {
    premium: [],
    balanced: [],
    fast: [],
    cheap: [],
  },
  evolve: {
    enabled: true,
    min_observations: 5,
    promote_threshold: 0.7,
    demote_threshold: 0.3,
    new_model_behavior: 'append',
  },
};

/**
 * Check if omo (oh-my-openagent) is installed in opencode.json.
 * If not, automatically add it to the plugin list.
 * Returns: { installed: boolean, message: string }
 */
function ensureOmoInstalled() {
  const configPath = getOpenCodeConfigDir();
  // opencode.json is at ~/.config/opencode/opencode.json on Linux/macOS,
  // but on Windows it might be at %APPDATA%\opencode\opencode.json or also at ~/.config/opencode/
  // Try both locations.
  const possiblePaths = [
    join(process.env.HOME || '/root', '.config', 'opencode', 'opencode.json'),
    join(process.env.APPDATA || '', 'opencode', 'opencode.json'),
  ];

  let opencodeConfigPath = null;
  let opencodeConfig = null;

  for (const p of possiblePaths) {
    if (existsSync(p)) {
      opencodeConfigPath = p;
      try {
        const content = readFileSync(p, 'utf-8');
        opencodeConfig = JSON.parse(content);
        break;
      } catch (e) {
        opencodeConfigPath = null;
      }
    }
  }

  if (!opencodeConfig || !opencodeConfigPath) {
    return { installed: false, message: 'opencode.json not found' };
  }

  const plugins = opencodeConfig.plugin || [];
  const hasOmo = plugins.some(p =>
    typeof p === 'string' && (p.includes('oh-my-openagent') || p.includes('omo'))
  );

  if (hasOmo) {
    return { installed: true, message: 'omo already installed' };
  }

  // Add oh-my-openagent@latest to plugin list
  plugins.push('oh-my-openagent@latest');
  opencodeConfig.plugin = plugins;

  try {
    writeFileSync(opencodeConfigPath, JSON.stringify(opencodeConfig, null, 2) + '\n', 'utf-8');
    return { installed: true, message: `omo added to ${opencodeConfigPath}` };
  } catch (e) {
    return { installed: false, message: `Failed to write opencode.json: ${e.message}` };
  }
}

// ─── Built-in Model Capability Database ──────────────────────────────────────

const TIER_SCORES = { premium: 100, balanced: 80, fast: 60, cheap: 40 };

function classifyByCost(cost) {
  if (!cost || typeof cost.input !== 'number' || typeof cost.output !== 'number') return null;
  const avg = (cost.input + cost.output) / 2;
  if (avg >= 10) return 'premium';
  if (avg >= 2) return 'balanced';
  if (avg >= 0.5) return 'fast';
  return 'cheap';
}

const OMO_MODEL_DB = {
  // Set by plugin after loadConfig — stores model_tiers from omf.json
  _configTiers: null,

  tiers: [
    {
      name: 'premium',
      label: 'Best Reasoning/Coding',
      patterns: [
        /^big-pickle$/,
        /^gpt-5/,
        /claude-sonnet-4/,
        /claude-opus/,
        /glm-5\.1/,
      ],
      score: 100,
    },
    {
      name: 'balanced',
      label: 'Balanced Performance',
      patterns: [
        /claude-sonnet(?!-4)/,
        /gpt-4[^.]/,
        /gpt-4o/,
        /gemini-pro/,
        /deepseek-v3/,
        /deepseek-r1/,
        /glm-5\b/,
        /gemini\b/,
        /deepseek\b/,
        /z-ai\//,
        /qwen\/qwen3-[0-9]+b/,
        /nvidia\/llama-3\.[13]-nemotron-ultra/,
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
        /glm-4\./,
        /flash\b/,
        /kimi\b/,
        /qwen\b/,
        /MiniMax/,
        /grok-.*fast/,
        /coder\b/,
        /minimaxai\//,
        /moonshotai\//,
        /qwen\/qwen3-coder/,
        /qwen\/qwen3\.5/,
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
        /glm-4\.7/,
        /grok-4\b/,
      ],
      score: 40,
    },
  ],

  classify(modelStr) {
    if (typeof modelStr !== 'string') return null;

    // Config tiers (from omf.json) take priority over hardcoded patterns
    if (this._configTiers && typeof this._configTiers === 'object') {
      for (const [tierName, models] of Object.entries(this._configTiers)) {
        if (Array.isArray(models) && models.includes(modelStr)) {
          const score = TIER_SCORES[tierName] || 50;
          const tierLabel = this.tiers.find(t => t.name === tierName)?.label || tierName;
          return { tier: tierName, score, name: tierLabel };
        }
      }
    }

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



// ─── Model Discovery (CLI only) ────────────────────────────────────────────

// Model discovery is done via discoverProviderApiModels() which calls
// \`opencode models\` CLI. No file-based discovery is used.

async function discoverProviderApiModels(configDir, verbose = false) {
  try {
    const cmd = verbose ? 'opencode models --verbose' : 'opencode models';
    const output = execSync(cmd, { encoding: 'utf-8', timeout: 120000 });
    
    if (verbose) {
      const models = parseVerboseModelOutput(output);
      const free = models.filter(m => m.status === 'active' && m.cost?.input === 0 && m.cost?.output === 0).length;
      const paid = models.filter(m => m.cost && (m.cost.input > 0 || m.cost.output > 0)).length;
      const inactive = models.filter(m => m.status && m.status !== 'active').length;
      console.log(`[omf] Discovered ${models.length} models via CLI (${free} free, ${paid} paid, ${inactive} inactive)`);
      return models;
    }

    const lines = output.trim().split('\n').filter(Boolean);
    
    const models = lines
      .map(id => id.trim())
      .filter(Boolean)
      .map(id => ({
        id,
        name: id.split('/').pop() || id,
        cost: null,
        source: 'cli',
      }));

    console.log(`[omf] Discovered ${models.length} models via \`opencode models\` CLI`);
    return models;
  } catch (e) {
    console.log(`[omf] \`opencode models\` CLI failed: ${e.message}`);
    return [];
  }
}

function parseVerboseModelOutput(output) {
  const models = [];
  const lines = output.trim().split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line) { i++; continue; }

    // Model ID line has format "provider/model-name"
    if (line.includes('/')) {
      const modelId = line;
      i++;
      const jsonLines = [];
      let braceCount = 0;
      let started = false;

      while (i < lines.length) {
        const jLine = lines[i];
        if (jLine.includes('{')) started = true;
        if (started) {
          braceCount += (jLine.match(/{/g) || []).length;
          braceCount -= (jLine.match(/}/g) || []).length;
          jsonLines.push(jLine);
        }
        i++;
        if (started && braceCount === 0) break;
      }

      try {
        const jsonStr = jsonLines.join('\n');
        const data = JSON.parse(jsonStr);
        models.push({
          id: modelId,
          name: data.name || modelId.split('/').pop() || modelId,
          cost: data.cost || null,
          status: data.status || 'unknown',
          providerID: data.providerID || null,
          source: 'cli',
        });
      } catch (e) {
        // Fallback: add model with minimal info on parse failure
        models.push({
          id: modelId,
          name: modelId.split('/').pop() || modelId,
          cost: null,
          status: null,
          providerID: null,
          source: 'cli',
        });
      }
    } else {
      i++;
    }
  }

  return models;
}

// ─── Fallback Chain Builder (linked list) ───────────────────────────────────

function inferModelCapabilities(modelId) {
  const caps = new Set();
  const id = modelId.toLowerCase();
  if (/vision|image|flux|dall.e|sdxl|paligemma/.test(id)) caps.add('vision');
  if (/code|coder|codex|codeqwen/.test(id)) caps.add('code');
  if (/reason(er|ing)/.test(id)) caps.add('reasoning');
  if (/flash|haiku|fast|mini|nano|small|3\.[125]-[18]b/.test(id)) caps.add('fast');
  if (/embed|rerank/.test(id)) caps.add('embedding');
  if (/whisper|speech|audio|tts/.test(id)) caps.add('audio');
  if (/instruct|chat|it$/.test(id)) caps.add('chat');
  // Most chat models support tools + streaming
  if (!caps.has('embedding')) { caps.add('tools'); caps.add('streaming'); }
  return caps;
}

function buildFallbackChain(models, strategy) {
  if (!models || models.length === 0) return { chain: [], links: {}, head: null };

  // Score each model
  const scored = models.map((modelId, idx) => {
    const tierInfo = OMO_MODEL_DB.classify(modelId) || { tier: 'balanced', score: 50 };
    const caps = inferModelCapabilities(modelId);
    let score;

    switch (strategy) {
      case 'price':
        // Invert: cheap=high score (sorts first), premium=low score (sorts last)
        score = 100 - tierInfo.score;
        break;
      case 'performance':
        score = tierInfo.score;
        break;
      case 'feature': {
        // Reference is the first model (highest tier). Score by capability overlap.
        const refId = models[0];
        const refCaps = inferModelCapabilities(refId);
        const refTier = OMO_MODEL_DB.classify(refId) || { score: 50 };
        if (refCaps.size === 0) { score = 0; break; }
        const intersection = [...caps].filter(c => refCaps.has(c)).length;
        const union = new Set([...caps, ...refCaps]).size;
        // Blend: 60% capability match + 40% tier alignment
        const capScore = union > 0 ? intersection / union : 0;
        const tierAlignment = modelId === refId ? 1 : 1 - Math.abs(refTier.score - tierInfo.score) / 100;
        score = capScore * 0.6 + tierAlignment * 0.4;
        break;
      }
      case 'comprehensive':
        score = tierInfo.score * 0.4 + (100 - tierInfo.score) * 0.3 + caps.size * 10 * 0.3;
        break;
      default:
        score = tierInfo.score;
    }

    return { modelId, score, tier: tierInfo.tier, caps, idx };
  });

  // Stable sort: same score → preserve original order
  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);

  const sorted = scored.map(s => s.modelId);
  const links = {};
  for (let i = 0; i < sorted.length - 1; i++) {
    links[sorted[i]] = sorted[i + 1];
  }

  // Safety: walk 5 steps from each node, assert no self-loop
  for (const modelId of sorted) {
    let current = links[modelId];
    for (let step = 0; step < 5; step++) {
      if (!current) break;
      if (current === modelId) {
        console.warn(`[omf] Cycle detected at ${modelId}, falling back to performance strategy`);
        return buildFallbackChain(models, 'performance');
      }
      current = links[current];
    }
  }

  return { chain: sorted, links, head: sorted[0] || null };
}

/**
 * Build a deep fallback chain ensuring each model has at least 3 non-repeating
 * fallback hops before reaching a terminal node.
 *
 * Chain length = omo required models count × 3 (minimum 4 for 3-hop depth).
 *
 * @param {string[]} availableModels - All models available via `opencode models` CLI
 * @param {string[]} omoRequiredModels - Models that omo agents/categories require (must be included)
 * @param {{ strategy?: string }} [options] - Optional configuration (strategy for future use)
 * @returns {{ chain: string[], links: {[model]: string|null}, head: string|null }}
 */
function buildDeepFallbackChain(availableModels, omoRequiredModels, options = {}) {
  if (!availableModels || availableModels.length === 0) {
    return { chain: [], links: {}, head: null };
  }
  if (!Array.isArray(omoRequiredModels)) {
    omoRequiredModels = [];
  }

  // 1. Build tier info lookup for each available model
  const modelInfo = new Map();
  for (const modelId of availableModels) {
    const tierInfo = OMO_MODEL_DB.classify(modelId) || { tier: 'balanced', score: TIER_SCORES.balanced };
    modelInfo.set(modelId, tierInfo);
  }

  // 2. Sort available models by tier score descending for primary ordering
  const sortedByTier = [...availableModels].sort((a, b) => {
    const scoreA = modelInfo.get(a)?.score || 0;
    const scoreB = modelInfo.get(b)?.score || 0;
    return scoreB - scoreA;
  });
  const allModelsSet = new Set(availableModels);

  // 3. First pass: include all omo-required models (deduplicated), warn if missing
  const chain = [];
  const seen = new Set();

  for (const modelId of omoRequiredModels) {
    if (!modelId || typeof modelId !== 'string') continue;
    if (!allModelsSet.has(modelId)) {
      console.warn(`[omf] buildDeepFallbackChain: omo-required model "${modelId}" not found in available models, skipping`);
      continue;
    }
    if (!seen.has(modelId)) {
      chain.push(modelId);
      seen.add(modelId);
    }
  }

  // 4. Calculate target chain length: omo model count × 3 (minimum 4 for 3-hop depth)
  const omoModelCount = chain.length;
  const targetLength = Math.max(4, omoModelCount * 3);

  // 5. Fill remaining chain positions with best-tier models (tier order), up to target
  for (const modelId of sortedByTier) {
    if (chain.length >= targetLength) break;
    if (!seen.has(modelId)) {
      chain.push(modelId);
      seen.add(modelId);
    }
  }

  // 6. Build links — each model points to the next in chain (forward-only, no cycles)
  const links = {};
  for (let i = 0; i < chain.length; i++) {
    links[chain[i]] = i + 1 < chain.length ? chain[i + 1] : null;
  }

  // 7. Validate depth constraint
  if (chain.length < 4) {
    console.warn(`[omf] buildDeepFallbackChain: chain length ${chain.length} < 4, depth constraint of 3 fallback hops cannot be satisfied`);
  }

  // 8. Validate no cycles (walk up to 10 steps from each node)
  for (const modelId of chain) {
    let current = links[modelId];
    for (let step = 0; step < 10; step++) {
      if (!current) break;
      if (current === modelId) {
        console.warn(`[omf] buildDeepFallbackChain: cycle detected at ${modelId}; this should not happen in a forward-only chain`);
        break;
      }
      current = links[current];
    }
  }

  return { chain, links, head: chain[0] || null };
}

/**
 * Walk from `proposedFallback` following `links` up to `maxHops` steps.
 * Returns true if `model` is encountered (cycle detected), false otherwise.
 *
 * @param {string} model - The original model node to check for
 * @param {string|null} proposedFallback - The proposed fallback target to start walking from
 * @param {{[model: string]: string|null}} links - The link map
 * @param {number} [maxHops=10] - Maximum traversal depth
 * @returns {boolean} true if a cycle is detected
 */
function createsCycle(model, proposedFallback, links, maxHops = 10) {
  if (!proposedFallback) return false;
  let current = proposedFallback;
  for (let step = 0; step < maxHops; step++) {
    if (!current) return false;
    if (current === model) return true;
    current = links[current];
  }
  return false;
}

async function autoOptimizeConfig(configDir, config) {
  if (!config.options?.auto_optimize) {
    return;
  }

  // Wire config tiers into OMO_MODEL_DB so classify() uses omf.json data
  if (config.model_tiers) {
    OMO_MODEL_DB._configTiers = config.model_tiers;
  }

  try {
    let apiModelObjs = [];
    try {
      apiModelObjs = await discoverProviderApiModels(configDir);
    } catch (e) {
      console.log(`[omf] Provider API discovery skipped: ${e.message}`);
    }
    const apiModelIds = apiModelObjs.map(m => m.id);
    const availableModels = apiModelIds;

    if (availableModels.length === 0) {
      console.log(`[omf] No models found via \`opencode models\` CLI`);
      return;
    }

    console.log(`[omf] Auto-optimize: ${availableModels.length} models discovered via CLI`);

    // Update model_tiers in config for visibility
    const newTiers = { premium: [], balanced: [], fast: [], cheap: [] };
    for (const modelId of availableModels) {
      const apiObj = apiModelObjs.find(m => m.id === modelId);
      const costTier = classifyByCost(apiObj?.cost);
      const patternTier = OMO_MODEL_DB.classify(modelId);
      const tier = costTier || patternTier?.tier || 'balanced';
      newTiers[tier].push(modelId);
    }
    config.model_tiers = newTiers;
    OMO_MODEL_DB._configTiers = newTiers;

    // Get performance data from evolution logs
    const performance = analyzeModelPerformance(configDir, 1);
    const performanceMap = new Map();
    for (const p of performance) {
      performanceMap.set(p.model, p);
    }

    // Create enhanced scoring based on performance and capabilities
    const scored = availableModels.map((modelId, idx) => {
      const tierInfo = OMO_MODEL_DB.classify(modelId) || { tier: 'balanced', score: 50 };
      const caps = inferModelCapabilities(modelId);
      const perfData = performanceMap.get(modelId) || { successRate: 0.5, avgLatency: 2000, totalCalls: 0 };
      
      let score = tierInfo.score;
      
      // Success rate: 0-100% -> 0-50 points (max 50 point boost)
      score += perfData.successRate * 50;
      
      // Latency: lower is better. 0-500ms = 0-30 bonus, 500-2000ms = 30-0 bonus, >2000ms = -40 penalty
      let latencyBonus = 0;
      if (perfData.avgLatency <= 500) {
        latencyBonus = 30;
      } else if (perfData.avgLatency <= 2000) {
        latencyBonus = 30 * (1 - (perfData.avgLatency - 500) / 1500);
      } else {
        latencyBonus = -40;
      }
      score += latencyBonus;
      
      // Capability match: compare with first model
      if (idx === 0) {
        // First model as reference
        score += caps.size * 2;
      } else {
        const refCaps = inferModelCapabilities(availableModels[0]);
        const intersection = [...caps].filter(c => refCaps.has(c)).length;
        const union = new Set([...caps, ...refCaps]).size;
        const capMatch = union > 0 ? intersection / union : 0;
        score += capMatch * 20;
      }
      
      // Ensure minimum score is 0
      score = Math.max(0, score);
      
      return { 
        modelId, 
        score, 
        tier: tierInfo.tier, 
        caps, 
        idx,
        latency: perfData.avgLatency,
        successRate: perfData.successRate
      };
    });

    // Stable sort by score, then by original order
    scored.sort((a, b) => b.score - a.score || a.idx - b.idx);

    const sorted = scored.map(s => s.modelId);
    const links = {};
    for (let i = 0; i < sorted.length - 1; i++) {
      links[sorted[i]] = sorted[i + 1];
    }

    // Safety: walk 5 steps from each node, assert no self-loop
    for (const modelId of sorted) {
      let current = links[modelId];
      for (let step = 0; step < 5; step++) {
        if (!current) break;
        if (current === modelId) {
          console.warn(`[omf] Cycle detected at ${modelId}, falling back to performance strategy`);
          return autoOptimizeConfig(configDir, config);
        }
        current = links[current];
      }
    }

    const optimizedChain = sorted;
    const currentChain = config.fallback_models?.default || [];

    const currentSorted = [...currentChain].sort().join(',');
    const optimizedSorted = [...optimizedChain].sort().join(',');

    if (currentSorted === optimizedSorted) {
      console.log(`[omf] Auto-optimize: fallback chain unchanged`);
      const configPath = join(configDir, 'omf.json');
      if (existsSync(configPath)) {
        try {
          writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
        } catch (e) {
          console.error(`[omf] Failed to write config: ${e.message}`);
        }
      }
      return;
    }

    config.fallback_models.default = optimizedChain;
    config.fallback_chain = {
      links: links,
      head: optimizedChain[0] || null,
      strategy: config.fallback_chain?.strategy || 'performance'
    };

    console.log(`[omf] Auto-optimized fallback chain structure:`);
    let current = config.fallback_chain.head;
    let index = 1;
    while (current) {
      const next = links[current] || 'END';
      console.log(`[omf]   ${index}. ${current} → ${next}`);
      current = next === 'END' ? null : links[current];
      index++;
    }

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
  min_observations: 3,
  promote_threshold: 0.7,
  demote_threshold: 0.5,
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

// ─── Real-time model statistics cache (weight-based fallback) ───────────────

const modelStats = {
  data: new Map(),   // modelName → { successes, failures, totalLatency, count }
  loaded: false,
};

function ensureModelStatsLoaded(configDir) {
  if (modelStats.loaded) return;
  const logPath = getEvolveLogPath(configDir);
  if (!existsSync(logPath)) { modelStats.loaded = true; return; }
  try {
    const raw = readFileSync(logPath, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        let m = modelStats.data.get(entry.m);
        if (!m) {
          m = { successes: 0, failures: 0, totalLatency: 0, count: 0 };
          modelStats.data.set(entry.m, m);
        }
        if (entry.s) m.successes++;
        else m.failures++;
        m.totalLatency += entry.l || 0;
        m.count++;
      } catch { /* skip malformed lines */ }
    }
    modelStats.loaded = true;
    console.log(`[omf] Loaded ${lines.length} evolve entries (${modelStats.data.size} models)`);
  } catch (e) {
    console.log(`[omf] Failed to load evolve data: ${e.message}`);
    modelStats.loaded = true;
  }
}

function recordModelOutcome(configDir, modelName, success, latencyMs, errorCode) {
  logModelOutcome(configDir, modelName, success, latencyMs, errorCode);
  let entry = modelStats.data.get(modelName);
  if (!entry) {
    entry = { successes: 0, failures: 0, totalLatency: 0, count: 0 };
    modelStats.data.set(modelName, entry);
  }
  if (success) entry.successes++;
  else entry.failures++;
  entry.totalLatency += latencyMs || 0;
  entry.count++;
}

function scoreModelWithWeights(modelName, weightConfig) {
  const entry = modelStats.data.get(modelName);
  const minObs = weightConfig.min_observations || 3;
  if (!entry || entry.count < minObs) {
    // Insufficient data → neutral score
    return 50;
  }

  const successRate = entry.successes / entry.count;
  const avgLatency = entry.totalLatency / entry.count;

  // successRate: 0..1, higher is better
  const successScore = successRate * (weightConfig.success_rate || 70);

  // avgLatency: cap at 10000ms, lower is better
  const normalizedLatency = Math.min(avgLatency / 10000, 1);
  const latencyScore = (1 - normalizedLatency) * (weightConfig.latency || 30);

  return successScore + latencyScore;
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
    const output = execSync('opencode models', { encoding: 'utf-8', timeout: 15000 });
    const lines = output.trim().split('\n').filter(Boolean);
    return lines
      .map(l => l.trim())
      .filter(id => id && !knownModels.includes(id));
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
          type: 'agent',
        };
      }
    }

    if (agentConfig.categories) {
      for (const [name, entry] of Object.entries(agentConfig.categories)) {
        entries[`[category] ${name}`] = {
          model: entry.model || null,
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

  const links = config.fallback_chain?.links;
  const head = config.fallback_chain?.head;
  if (!links || !head) return false;

  // Collect all models in chain order
  const order = [];
  let current = head;
  while (current) {
    order.push(current);
    current = links[current];
  }
  if (order.length === 0) return false;

  const performance = analyzeModelPerformance(configDir, evolveOpts.min_observations);

  const promoteSet = new Set();
  const demoteSet = new Set();

  for (const p of performance) {
    if (p.successRate >= evolveOpts.promote_threshold) promoteSet.add(p.model);
    else if (p.successRate <= evolveOpts.demote_threshold) demoteSet.add(p.model);
  }

  const perfByModel = {};
  for (const p of performance) perfByModel[p.model] = p;

  const promoted = order.filter(m => promoteSet.has(m));
  const demoted = order.filter(m => demoteSet.has(m));
  const unchanged = order.filter(m => !promoteSet.has(m) && !demoteSet.has(m));

  promoted.sort((a, b) => (perfByModel[b]?.successRate || 0) - (perfByModel[a]?.successRate || 0));

  let newModels = [];
  if (evolveOpts.new_model_behavior === 'append') {
    newModels = discoverNewModels(order, configDir);
    if (newModels.length > 0) {
      console.log(`[omf] Discovered new model(s): ${newModels.join(', ')}`);
    }
  }

  const newOrder = [...promoted, ...unchanged, ...demoted, ...newModels];

  if (newOrder.join(',') !== order.join(',')) {
    // Rebuild linked list
    const newLinks = {};
    for (let i = 0; i < newOrder.length - 1; i++) {
      newLinks[newOrder[i]] = newOrder[i + 1];
    }
    config.fallback_chain.links = newLinks;
    config.fallback_chain.head = newOrder[0];
    config.fallback_models.default = newOrder;

    console.log(`[omf] Evolved fallback chain: [${newOrder.join(', ')}]`);

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

/**
 * Sink a failed model toward the end of the chain.
 * Swaps the model with the next model in the chain, so it moves one step back.
 * After repeated failures, it eventually reaches the end.
 * @param {object} config - omf config
 * @param {string} modelToSink - model to sink
 * @param {string} configDir - config directory
 */
function sinkModelToEnd(config, modelToSink, configDir) {
  const models = config.fallback_models.default;
  const links = config.fallback_chain?.links || {};
  if (!models || models.length < 2) return;

  const idx = models.indexOf(modelToSink);
  if (idx === -1 || idx >= models.length - 1) return; // already at end

  // Swap with the next model (move backward one position)
  const swapIdx = Math.min(idx + 1, models.length - 1);
  [models[idx], models[swapIdx]] = [models[swapIdx], models[idx]];

  // Rebuild links from the updated chain
  const newLinks = {};
  for (let i = 0; i < models.length - 1; i++) {
    newLinks[models[i]] = models[i + 1];
  }
  newLinks[models[models.length - 1]] = null; // terminal

  config.fallback_chain.links = newLinks;
  config.fallback_chain.head = models[0];

  // Persist immediately
  const configPath = join(configDir, 'omf.json');
  try {
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  } catch (e) {
    console.error(`[omf] Failed to save sink config: ${e.message}`);
  }
}

// ─── Agent name detection (mirrors oh-my-opencode's logic) ────────────────────

const AGENT_NAMES = [
  'sisyphus', 'hephaestus', 'prometheus', 'atlas',
  'oracle', 'librarian', 'explore', 'metis', 'momus',
  'sisyphus-junior', 'multimodal-looker',
];

function extractAgentName(sessionID) {
  if (typeof sessionID !== 'string') return null;
  const lower = sessionID.toLowerCase();
  for (const name of [...AGENT_NAMES].sort((a, b) => b.length - a.length)) {
    const escaped = name.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    const re = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i');
    if (re.test(lower)) return name.toLowerCase();
  }
  return null;
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
  // Explicit check for CDP/MCP error codes (e.g., -32000 = connection closed)
  const errorCode = error.code ?? error.data?.code;
  if (typeof errorCode === 'number' && errorCode < 0 && errorCode >= -33000 && errorCode <= -32000) return true;
  if (error.name === 'ProviderAuthError') return false;

  // Build error text early to allow MessageAbortedError content inspection.
  // OpenCode wraps resource-exhaustion / worker-limit errors as MessageAbortedError,
  // so we must check for those patterns BEFORE the MessageAbortedError exclusion.
  const errorText = [
    error.message,
    error.data?.message,
    error.data?.detail,
    error.name,
    typeof error.data === 'string' ? error.data : null,
    typeof error === 'string' ? error : null,
  ].filter(Boolean).join(' ').toLowerCase();

  // Resource exhaustion (worker limit, quota) — checked before MessageAbortedError
  // so that OpenCode's abort wrapping doesn't silently skip fallback.
  if (/resourceexhausted|worker.*total.*request.*limit/i.test(errorText)) return true;

  // NotFoundError — OpenCode may wrap model-not-found as MessageAbortedError.
  // Check before the exclusion so a gone model still triggers fallback.
  if (/notfounderror|not found/i.test(errorText)) return true;

  // DEGRADED function — model is temporarily unavailable/degraded
  if (/degraded.*function|function.*degraded|degraded.*cannot/i.test(errorText)) return true;

  if (error.name === 'MessageAbortedError') return false;

  if (/too many requests|rate limit|retrying in|429|free usage exceeded|resourceexhausted/.test(errorText)) return true;
  if (/timeout|timed out|etimedout|econnreset|connection reset|connection refused|connect ehostunreach|network error|socket hang|promptservicerequestfailed|providermodelnotfounderror|model not found|modelnotfound|connection closed|-32000/i.test(errorText)) return true;
  if (/cannot connect to api|socket.*connection.*closed.*unexpectedly|socket.*connection.*closed|connection.*closed.*unexpectedly/i.test(errorText)) return true;
  if (/gone|410.*model|model.*no longer available|end of life|deprecated.*model|model.*deprecated|has reached.*eol/i.test(errorText)) return true;
  if (/failed to execute statement|statement failed|execution failed|execute failed/i.test(errorText)) return true;
  if (/not found|404.*openai|openai.*404|providermodelnotfounderror/i.test(errorText)) return true;
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
    /insufficient.*(quota|balance|credit|额度|余额)/i.test(text) ||
    /resourceexhausted|worker.*total.*request.*limit/i.test(text);
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

  // Model EOL / Gone responses (410 Gone, 404 Not Found: model no longer available)
  if (/gone|410.*model.*(no longer|not available)|model.*(no longer available|deprecated|eol|end of life)|has reached.*eol|not found|404.*model/i.test(text.trim())) {
    return { reason: 'model_gone', detail: 'model is deprecated or no longer available' };
  }

  // DEGRADED function — model temporarily unavailable
  if (/degraded.*function|function.*degraded|degraded.*cannot/i.test(text.trim())) {
    return { reason: 'degraded', detail: 'model is degraded/unavailable' };
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

function cleanOmoFallbacks(configDir) {
  // omf no longer modifies oh-my-opencode.json.
  // omf and omo's runtime-fallback hooks coexist — each handles its own scope:
  //   omo: transport-level errors (session.error, session.status)
  //   omf: content-level detection (message.updated)
  //
  // See the hook handler in plugin() for the full story.

  // Clean up omf.json: remove legacy per-agent fallback config
  const omfConfigPath = join(configDir, 'omf.json');
  if (!existsSync(omfConfigPath)) return;
  try {
    const omfRaw = readFileSync(omfConfigPath, 'utf-8');
    const omfConfig = JSON.parse(omfRaw);
    if (omfConfig.fallback_models?.agents) {
      delete omfConfig.fallback_models.agents;
      writeFileSync(omfConfigPath, JSON.stringify(omfConfig, null, 2) + '\n', 'utf-8');
      console.log(`[omf] Cleaned legacy agents config from omf.json`);
    }
  } catch (e) {
    console.log(`[omf] Failed to clean omf.json: ${e.message}`);
  }
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

const plugin = async (input, options) => {
  const configDir = options?.configDir || getOpenCodeConfigDir();
  const config = loadConfig(configDir);
  
  // Store ctx for probeAvailableModels and other ctx-dependent operations
  if (input?.ctx) _pluginCtx = input.ctx;

  if (config.model_tiers) {
    OMO_MODEL_DB._configTiers = config.model_tiers;
  }

  cleanOmoFallbacks(configDir);

  await autoOptimizeConfig(configDir, config);
  evolveFallbackChain(configDir, config);

  const sessionStates = new Map();

  function getOrCreateSessionState(sessionID) {
    let state = sessionStates.get(sessionID);
    if (!state) {
      state = {
        currentFallbackModel: null,
        attemptCount: 0,
        failedModels: new Map(),
        failedProviders: new Map(),
        pending: false,
        exhaustionRounds: 0,
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

    let models = config.fallback_models.default;
    let links = config.fallback_chain?.links || null;
    if (!models || models.length === 0) return;

    const providerCooldown = (config.options.provider_cooldown_seconds || 60) * 1000;

    let nextModel = null;
    const weightConfig = config.options.weights;

    if (weightConfig?.enabled) {
      // Weight-based model selection: score all candidates, pick the best
      ensureModelStatsLoaded(configDir);
      const candidates = [];
      for (const candidate of models) {
        if (isModelOnCooldown(candidate, state)) continue;
        const parsed = parseModelString(candidate);
        if (!parsed) continue;
        const providerTs = state.failedProviders.get(parsed.providerID);
        if (providerTs && (Date.now() - providerTs) < providerCooldown) {
          console.log(`[omf] Skipping ${candidate}: provider ${parsed.providerID} on circuit breaker`);
          continue;
        }
        candidates.push({
          modelId: candidate,
          score: scoreModelWithWeights(candidate, weightConfig),
        });
      }
      candidates.sort((a, b) => b.score - a.score);
      nextModel = candidates[0]?.modelId || null;
      if (nextModel) {
        console.log(`[omf] ${sessionID}: weighted selection → ${nextModel} (score: ${candidates[0].score.toFixed(1)} from ${candidates.length} candidates)`);
      }
    } else {
      // Linked list resolution: walk from current position (legacy mode)
      if (links) {
        if (!state.currentFallbackModel) {
          state.currentFallbackModel = config.fallback_chain?.head || models[0];
        } else {
          const nextFromLinks = links[state.currentFallbackModel];
          if (nextFromLinks) {
            state.currentFallbackModel = nextFromLinks;
          } else {
            state.currentFallbackModel = null;
          }
        }
      }

      let startIndex = 0;
      if (state.currentFallbackModel) {
        startIndex = models.indexOf(state.currentFallbackModel);
        if (startIndex === -1) startIndex = 0;
      }

      while (startIndex < models.length) {
        const candidate = models[startIndex];
        startIndex++;

        if (isModelOnCooldown(candidate, state)) continue;
        const parsed = parseModelString(candidate);
        if (!parsed) continue;
        const providerTs = state.failedProviders.get(parsed.providerID);
        if (providerTs && (Date.now() - providerTs) < providerCooldown) {
          console.log(`[omf] Skipping ${candidate}: provider ${parsed.providerID} on circuit breaker`);
          continue;
        }
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
    }

    if (!nextModel) {
      // All models exhausted this round — clear cooldowns and retry from head
      state.exhaustionRounds = (state.exhaustionRounds || 0) + 1;
      const maxExhaustionRounds = 3;
      if (state.exhaustionRounds >= maxExhaustionRounds) {
        console.log(`[omf] ${sessionID}: exhausted all models for ${maxExhaustionRounds} rounds — giving up`);
        sessionStates.delete(sessionID);
        return;
      }
      console.log(`[omf] ${sessionID}: all models exhausted — clearing cooldowns, round ${state.exhaustionRounds}/${maxExhaustionRounds}`);
      state.failedModels.clear();
      state.failedProviders.clear();
      state.currentFallbackModel = null;
      // Reset attemptCount so max_retries doesn't kill the new round prematurely
      state.attemptCount = 0;
      return tryManualFallback(ctx, sessionID);
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

      try {
        await ctx.client.session.abort({ path: { id: sessionID } });
      } catch (abortErr) {
        // Session was already aborted — expected in dual-hook env (omo's runtime-fallback).
        // Continue with retry regardless; abort is only needed to stop a running stream.
        console.log(`[omf] ${sessionID}: abort coordination (session may already be handled): ${abortErr.message}`);
      }

      const parsed = parseModelString(nextModel);
      await ctx.client.session.promptAsync({
        path: { id: sessionID },
        body: {
          model: { providerID: parsed.providerID, modelID: parsed.modelID },
          parts,
        },
        query: { directory: ctx.directory },
      });

      recordModelOutcome(configDir, nextModel, true, Date.now() - fallbackStartTime);
      // Reset consecutive failure counter on success
      state[`consecutive_${nextModel}`] = 0;
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
      recordModelOutcome(configDir, nextModel, false, Date.now() - fallbackStartTime, extractStatusCode(e));
      console.log(`[omf] ${sessionID}: fallback attempt failed:`, e.message);
      state.failedModels.set(nextModel, Date.now());
      const failParsed = parseModelString(nextModel);
      if (failParsed) state.failedProviders.set(failParsed.providerID, Date.now());

      // Runtime sinking: track consecutive failures per model
      const consecutiveKey = `consecutive_${nextModel}`;
      const prevConsecutive = state[consecutiveKey] || 0;
      state[consecutiveKey] = prevConsecutive + 1;

      if (prevConsecutive >= 1) {
        // 2+ consecutive failures → sink this model to the end of the chain
        sinkModelToEnd(config, nextModel, configDir);
        console.log(`[omf] ${sessionID}: model ${nextModel} failed ${prevConsecutive + 1}× consecutively — sunk to chain end`);
      }

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
        if (!sessionID) return;

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

      // Intercept OpenCode's built-in retry loop (fires for main model 429/rate-limit)
      // Only intercept the FIRST retry attempt — subsequent ones are handled by omf's own fallback chain
      if (event.type === 'session.status') {
        const props = event.properties;
        if (!props?.sessionID) return;
        const status = props.status;
        if (status?.type === 'retry' && status.attempt === 1) {
          const sessionID = props.sessionID;
          const msg = (status.message || '').toLowerCase();
          if (/too many requests|rate limit|retrying in|429|free usage exceeded|connection closed|-32000|resourceexhausted|degraded|not found|model.*(gone|eol|deprecated)/i.test(msg)) {
            console.log(`[omf] ${sessionID}: intercepting first retry (attempt ${status.attempt}) — ${status.message}`);
            // Don't reset pending — let tryManualFallback's own pending check handle concurrency
            await tryManualFallback(input, sessionID);
          }
        }
      }

      if (event.type === 'session.error') {
        const props = event.properties;
        if (!props?.sessionID) return;

        const error = props.error;
        if (!error || !isRetryableError(error, config.options.retry_on_errors)) return;

        console.log(`[omf] ${props.sessionID}: session error (${error.name}) — queuing fallback (deferred for coordination)`);

        // Defer to end of macrotask queue so omo's runtime-fallback handler runs first.
        // omo starts its retry → then omf's deferred callback fires, aborts omo's retry,
        // and starts our own retry with omf's chain model. This ensures omf owns the
        // fallback decision regardless of handler dispatch order.
        setTimeout(() => {
          tryManualFallback(input, props.sessionID).catch(err => {
            console.log(`[omf] ${props.sessionID}: deferred fallback error:`, err.message);
          });
        }, 0);
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
  
  const head = config.fallback_chain?.head;
  const links = config.fallback_chain?.links || {};
  
  if (head) {
    let current = head;
    let index = 1;
    while (current) {
      const next = links[current] || 'END';
      const cls = OMO_MODEL_DB.classify(current);
      const label = cls ? ` (${cls.name})` : '';
      console.log(`[omf] ${index}. ${current}${label} → ${next}`);
      current = next === 'END' ? null : links[current];
      index++;
    }
  } else {
    (config.fallback_models?.default || []).forEach((m, i) => {
      const cls = OMO_MODEL_DB.classify(m);
      const label = cls ? ` (${cls.name})` : '';
      console.log(`[omf] ${i + 1}) ${m}${label}`);
    });
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
    (evolve.enabled ? ` (min_obs=${evolve.min_observations}, promote≥${evolve.promote_threshold}, demote≤${evolve.demote_threshold})` : ''));
}

async function tuiAutoOptimize(configDir, config) {
  if (config.model_tiers) {
    OMO_MODEL_DB._configTiers = config.model_tiers;
  }

  const strategy = config.fallback_chain?.strategy || 'performance';

  console.log(`[omf] Scanning for available models (strategy: ${strategy})...`);
  const apiModelObjs = await discoverProviderApiModels(configDir);
  const apiModelIds = apiModelObjs.map(m => m.id);
  const allModels = apiModelIds;

  if (allModels.length === 0) {
    console.log(`[omf] No models found via \`opencode models\` CLI.`);
    return false;
  }
  console.log(`[omf] Discovered ${allModels.length} model(s) via CLI`);

  const { chain, links, head } = buildFallbackChain(allModels, strategy);
  console.log(`[omf] Chain head: ${head}`);
  console.log(`[omf] Chain (${chain.length} models): ${chain.join(' → ')}`);

  config.fallback_chain = config.fallback_chain || {};
  config.fallback_chain.strategy = strategy;
  config.fallback_chain.links = links;
  config.fallback_chain.head = head;
  config.fallback_models.default = chain;

  const configPath = join(configDir, 'omf.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  console.log(`[omf] Config saved to ${configPath}`);
  return true;
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
      const apiModels = await discoverProviderApiModels(configDir);
      if (apiModels.length === 0) {
        console.log(`[omf] \`opencode models\` returned no models. Ensure OpenCode is running.`);
      } else {
        apiModels.forEach((m) => {
          const cls = OMO_MODEL_DB.classify(m.id);
          const label = cls ? ` (${cls.name})` : '';
          console.log(`[omf]   ${m.id}${label}`);
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

/**
 * Extract all model IDs required by omo from oh-my-opencode.json.
 * Reads agents + categories sections and collects unique model IDs.
 */
function getOmoRequiredModels(configDir) {
  const models = new Set();

  // Try multiple possible locations for oh-my-opencode.json
  const possiblePaths = [
    join(process.env.APPDATA || '', 'opencode', 'oh-my-opencode.json'),
    join(process.env.HOME || '/root', '.config', 'opencode', 'oh-my-opencode.json'),
    join(process.env.HOME || '/root', '.config', 'opencode', 'oh-my-openagent.json'),
  ];

  for (const configPath of possiblePaths) {
    if (!existsSync(configPath)) continue;
    try {
      const content = readFileSync(configPath, 'utf-8');
      const omoConfig = JSON.parse(content);

      // Collect from agents
      if (omoConfig.agents) {
        for (const [name, agent] of Object.entries(omoConfig.agents)) {
          if (agent.model) models.add(agent.model);
          if (agent.fallback_models && Array.isArray(agent.fallback_models)) {
            agent.fallback_models.forEach(m => models.add(m));
          }
        }
      }

      // Collect from categories
      if (omoConfig.categories) {
        for (const [name, cat] of Object.entries(omoConfig.categories)) {
          if (cat.model) models.add(cat.model);
          if (cat.fallback_models && Array.isArray(cat.fallback_models)) {
            cat.fallback_models.forEach(m => models.add(m));
          }
        }
      }

      break; // Use first found file
    } catch (e) {
      // Skip bad file, try next
    }
  }

  return [...models];
}

/**
 * Standard mapping of omo agent/category → model.
 * Source: https://mp.weixin.qq.com/s/Y4EeXPoLPGVsnR8rtEEOcw
 * This is the canonical configuration that defines all models omo uses.
 * Used as the source of truth for building the fallback chain.
 * @type {{ agents: {[name]: string}, categories: {[name]: string} }}
 */
const STANDARD_OMO_CONFIG = {
  agents: {
    sisyphus: 'claude-opus-4-6',
    hephaestus: 'gpt-5.4',
    prometheus: 'claude-opus-4-6',
    atlas: 'claude-sonnet-4-6',
    oracle: 'gpt-5.4',
    librarian: 'minimax-m2.7',
    explore: 'grok-code-fast-1',
    metis: 'claude-opus-4-6',
    momus: 'gpt-5.4',
    'sisyphus-junior': 'claude-sonnet-4-6',
    'multimodal-looker': 'gpt-5.4',
  },
  categories: {
    'visual-engineering': 'gemini-3.1-pro',
    ultrabrain: 'gpt-5.4',
    deep: 'gpt-5.4',
    artistry: 'gemini-3.1-pro',
    quick: 'gpt-5.4-mini',
    'unspecified-low': 'claude-sonnet-4-6',
    'unspecified-high': 'claude-opus-4-6',
    writing: 'gemini-3-flash',
  },
};

/**
 * Extract all unique model IDs from the standard omo config.
 * @returns {string[]}
 */
function getStandardOmoModels() {
  const models = new Set();
  if (STANDARD_OMO_CONFIG.agents) {
    for (const [, model] of Object.entries(STANDARD_OMO_CONFIG.agents)) {
      if (model) models.add(model);
    }
  }
  if (STANDARD_OMO_CONFIG.categories) {
    for (const [, model] of Object.entries(STANDARD_OMO_CONFIG.categories)) {
      if (model) models.add(model);
    }
  }
  return [...models];
}

/**
 * Map unavailable omo models to free equivalents from available models.
 * Uses strip-version heuristic to find free equivalent.
 * Also writes updated config back to oh-my-opencode.json.
 * @param {string} omoConfigPath - path to oh-my-opencode.json
 * @param {string[]} availableModelIds - free model IDs from CLI
 * @returns {{ updatedConfig: object|null, replaced: Array<{from:string, to:string}> }}
 */
function updateOmoModels(omoConfigPath, availableModelIds) {
  if (!existsSync(omoConfigPath)) return { updatedConfig: null, replaced: [] };

  try {
    const raw = readFileSync(omoConfigPath, 'utf-8');
    const omoConfig = JSON.parse(raw);
    const availableSet = new Set(availableModelIds);
    const replaced = [];

    // Strip version suffix to find free equivalent
    // e.g. axon/claude-opus-4-6 → axon/claude-opus
    const stripVersion = (modelId) => {
      const parts = modelId.split('/');
      if (parts.length !== 2) return modelId;
      const provider = parts[0];
      const model = parts[1];
      const cleaned = model.replace(/-\d+(\.\d+)*(-\w+)?$/, '');
      return `${provider}/${cleaned}`;
    };

    // Process agents
    if (omoConfig.agents) {
      for (const [name, agent] of Object.entries(omoConfig.agents)) {
        if (!agent.model) continue;
        const model = agent.model;
        if (!availableSet.has(model)) {
          const freeCandidate = stripVersion(model);
          if (availableSet.has(freeCandidate)) {
            agent.model = freeCandidate;
            replaced.push({ from: model, to: freeCandidate });
          }
        }
      }
    }

    // Process categories
    if (omoConfig.categories) {
      for (const [name, cat] of Object.entries(omoConfig.categories)) {
        if (!cat.model) continue;
        const model = cat.model;
        if (!availableSet.has(model)) {
          const freeCandidate = stripVersion(model);
          if (availableSet.has(freeCandidate)) {
            cat.model = freeCandidate;
            replaced.push({ from: model, to: freeCandidate });
          }
        }
      }
    }

    if (replaced.length > 0) {
      writeFileSync(omoConfigPath, JSON.stringify(omoConfig, null, 2) + '\n', 'utf-8');
    }

    return { updatedConfig: omoConfig, replaced };
  } catch (e) {
    console.log(`[omf] Failed to update omo models: ${e.message}`);
    return { updatedConfig: null, replaced: [] };
  }
}

/**
 * Probe a single model to verify it actually responds.
 * Sends a minimal "." prompt via session.promptAsync with timeout.
 * @param {object} modelInfo - { id, providerID, modelID }
 * @param {object} ctx - plugin context (input.ctx)
 * @param {number} timeoutMs - timeout in ms (default 15000)
 * @returns {Promise<{ ok: boolean, modelId: string, error?: string }>}
 */
async function probeModel(modelInfo, ctx, timeoutMs = 15000) {
  const modelId = modelInfo.id;
  const providerID = modelInfo.providerID || modelId.split('/')[0];
  const modelID = modelId.split('/').slice(1).join('/');
  
  if (!providerID || !modelID) {
    return { ok: false, modelId, error: 'invalid model ID format' };
  }
  
  const start = Date.now();
  try {
    // Race the actual request vs a timeout
    await Promise.race([
      ctx.client.session.promptAsync({
        path: { id: `omf-probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
        body: {
          model: { providerID, modelID },
          parts: [{ type: 'text', text: '.' }],
        },
        query: { directory: ctx.directory },
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
    ]);
    
    const elapsed = Date.now() - start;
    return { ok: true, modelId, latency: elapsed };
  } catch (e) {
    const msg = (e.message || '').toLowerCase();
    // Normalize known failure reasons for cleaner logging
    if (msg.includes('not found') || msg.includes('404')) {
      return { ok: false, modelId, error: 'model not found (404)' };
    }
    if (msg.includes('timeout')) {
      return { ok: false, modelId, error: 'request timed out' };
    }
    if (msg.includes('auth') || msg.includes('unauthorized') || msg.includes('forbidden')) {
      return { ok: false, modelId, error: 'auth error' };
    }
    if (msg.includes('rate') || msg.includes('too many') || msg.includes('429')) {
      return { ok: false, modelId, error: 'rate limited (429)' };
    }
    return { ok: false, modelId, error: e.message };
  }
}

/**
 * Probe all candidate models and return only those that respond successfully.
 * @param {object[]} candidateModels - models from CLI with id/providerID/modelID
 * @param {object} ctx - plugin context
 * @param {number} timeoutMs - per-model timeout (default 15000ms)
 * @returns {Promise<object[]>} models that passed the probe
 */
async function probeAvailableModels(candidateModels, ctx, timeoutMs = 15000) {
  const results = [];
  const failed = [];
  
  console.log(`[omf] Probing ${candidateModels.length} candidate models...`);
  
  for (let i = 0; i < candidateModels.length; i++) {
    const model = candidateModels[i];
    const progress = `${i + 1}/${candidateModels.length}`;
    process.stdout.write(`\r[omf]   ${progress} — probing ${model.id}...`);
    
    const result = await probeModel(model, ctx);
    
    if (result.ok) {
      results.push(model);
    } else {
      failed.push({ id: model.id, error: result.error });
    }
  }
  
  console.log(`\n[omf] Probe complete: ${results.length}/${candidateModels.length} models available`);
  if (failed.length > 0 && failed.length <= 5) {
    failed.forEach(f => console.log(`[omf]   ✗ ${f.id}: ${f.error}`));
  } else if (failed.length > 5) {
    console.log(`[omf]   ✗ ${failed.length} models failed (showing first 5)`);
    failed.slice(0, 5).forEach(f => console.log(`[omf]   ✗ ${f.id}: ${f.error}`));
  }
  
  return results;
}

// ─── Init: Discover & Configure ─────────────────────────────────────────────

async function tuiInit(configDir, config) {
  console.log(`\n[omf] ═══ omf Init — Discover & Configure ═══`);

  if (config.model_tiers) {
    OMO_MODEL_DB._configTiers = config.model_tiers;
  }

  // ─── Step 1: Auto-install omo ───
  console.log(`\n[omf] ─── Step 1: Checking omo installation ───`);
  const omoCheck = ensureOmoInstalled();
  console.log(`[omf] ${omoCheck.message}`);
  if (!omoCheck.installed) {
    console.log(`[omf] WARNING: Could not verify/add omo installation`);
  }

  // ─── Step 2: Discover all models via CLI ───
  console.log(`\n[omf] ─── Step 2: Discovering models via CLI ───`);
  const apiModelObjs = await discoverProviderApiModels(configDir, true);
  const allModelIds = apiModelObjs.map(m => m.id);

  console.log(`[omf] Models discovered via CLI: ${allModelIds.length}`);
  if (allModelIds.length === 0) {
    console.log(`[omf] No models found. Ensure OpenCode is installed and 'opencode' is in PATH.`);
    return false;
  }

  // ─── Step 3: Availability filtering (status + cost) ───
  console.log(`\n[omf] ─── Step 3: Filtering by availability ───`);

  // Filter by CLI-reported status and cost
  const activeFree = apiModelObjs.filter(m =>
    m.status === 'active' && (!m.cost || (m.cost.input === 0 && m.cost.output === 0))
  );
  const activePaid = apiModelObjs.filter(m =>
    m.status === 'active' && m.cost && (m.cost.input > 0 || m.cost.output > 0)
  );
  const inactiveModels = apiModelObjs.filter(m => m.status && m.status !== 'active');
  const statusUnknown = apiModelObjs.filter(m => !m.status);

  const nFree = activeFree.length;
  const nPaid = activePaid.length;
  const nInactive = inactiveModels.length;
  const nUnknown = statusUnknown.length;

  console.log(`[omf]   ✓ Free+Active:  ${nFree}`);
  if (nPaid > 0)    console.log(`[omf]   💰 Paid:         ${nPaid}`);
  if (nInactive > 0) console.log(`[omf]   ✗ Inactive:     ${nInactive}`);
  if (nUnknown > 0)  console.log(`[omf]   ? Unknown:      ${nUnknown}`);

  // Free models + unknown-status models are candidates for inclusion
  // (unknown status might mean not yet probed — include by default)
  let candidateModels = [...activeFree, ...statusUnknown];

  // For paid models, ask user
  if (nPaid > 0) {
    console.log(`\n[omf] Paid models detected (require API billing):`);
    activePaid.forEach((m, i) => {
      const costStr = m.cost ? `(in:${m.cost.input}, out:${m.cost.output})` : '';
      console.log(`[omf]   ${i + 1}) ${m.id} ${costStr}`);
    });
    const includePaid = await readLine(`[omf] Include paid models? (y/n, default: n): `);
    if (includePaid.trim().toLowerCase() === 'y' || includePaid.trim().toLowerCase() === 'yes') {
      candidateModels.push(...activePaid);
      console.log(`[omf] Paid models included.`);
    } else {
      console.log(`[omf] Paid models excluded.`);
    }
  }

  // Show filtered-out inactive models
  if (nInactive > 0) {
    console.log(`\n[omf] Excluded ${nInactive} inactive model(s):`);
    inactiveModels.forEach(m => console.log(`[omf]   ✗ ${m.id}`));
  }

  let candidateIds = candidateModels.map(m => m.id);
  console.log(`[omf] Candidate models after filtering: ${candidateIds.length}/${allModelIds.length}`);

  if (candidateIds.length === 0) {
    console.log(`[omf] No available models after filtering. Aborting.`);
    return false;
  }

  // ─── Step 3b: Real API probe to verify models actually respond ───
  if (_pluginCtx && candidateModels.length > 0) {
    console.log(`\n[omf] ─── Step 3b: Probing model availability (real API calls) ───`);
    candidateModels = await probeAvailableModels(candidateModels, _pluginCtx);
    if (candidateModels.length === 0) {
      console.log(`[omf] No models passed the probe. Aborting.`);
      return false;
    }
    // Recalculate candidateIds from probed models
    candidateIds = candidateModels.map(m => m.id);
  } else if (!_pluginCtx) {
    console.log(`[omf] ─── Step 3b: Skipping probe (no plugin context — running standalone) ───`);
  }

  // ─── Step 4: Get omo model requirements ───
  console.log(`\n[omf] ─── Step 4: Reading omo model requirements ───`);
  const omoRequiredModels = getOmoRequiredModels(configDir);
  console.log(`[omf] Models required by omo (from oh-my-opencode.json): ${omoRequiredModels.length}`);
  omoRequiredModels.forEach(m => console.log(`[omf]   • ${m}`));

  // ─── Step 5: Build deep fallback chain (≥3 fallback hops per model) ───
  console.log(`\n[omf] ─── Step 5: Building fallback chain ───`);

  OMO_MODEL_DB._configTiers = config.model_tiers || null;
  const strategy = config.fallback_chain?.strategy || 'performance';
  const { chain, links, head } = buildDeepFallbackChain(candidateIds, omoRequiredModels, { strategy });

  if (chain.length === 0) {
    console.log(`[omf] No chain could be built. Aborting.`);
    return false;
  }

  console.log(`[omf] Chain built (${chain.length} models, strategy: ${strategy}):`);
  chain.forEach((m, i) => {
    const tierInfo = OMO_MODEL_DB.classify(m);
    const next = links[m];
    const tierLabel = tierInfo ? ` (${tierInfo.tier})` : '';
    const nextLabel = next ? ` → ${next}` : ' ⏹';
    console.log(`[omf] ${i + 1}) ${m}${tierLabel}${nextLabel}`);
  });

  // Check if all omo-required models are in chain
  const missingOmo = omoRequiredModels.filter(m => !chain.includes(m));
  if (missingOmo.length > 0) {
    console.log(`[omf] WARNING: ${missingOmo.length} omo-required model(s) not in chain:`);
    missingOmo.forEach(m => console.log(`[omf]   ✗ ${m} (not available or filtered out)`));
  }

  // ─── Step 6: Confirm and write ───
  console.log(``);
  const ok = await readLine(`[omf] Apply this configuration? (y/n): `);
  const answer = ok.trim().toLowerCase();

  if (answer !== 'y' && answer !== 'yes') {
    console.log(`[omf] Cancelled.`);
    return false;
  }

  config.model_tiers = config.model_tiers || {};
  config.fallback_models = config.fallback_models || {};
  config.fallback_models.default = chain;
  config.fallback_models.agents = config.fallback_models.agents || {};
  config.fallback_chain = config.fallback_chain || {};
  config.fallback_chain.strategy = strategy;
  config.fallback_chain.head = head;
  config.fallback_chain.links = links;

  const configPath = join(configDir, 'omf.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  console.log(`[omf] Config saved to ${configPath}`);

  return true;
}

/**
 * Non-interactive init — auto-executes the full init flow.
 * Flow: discover → filter → update omo → build chain → write.
 * Defaults: exclude paid models, auto-apply config.
 * @param {string} configDir - omf config directory
 * @param {object} config - current omf config (merged with defaults)
 * @returns {Promise<boolean>} true on success
 */
async function runInit(configDir, config) {
  console.log(`\n[omf] ═══ omf Init (non-interactive) ═══`);

  if (config.model_tiers) {
    OMO_MODEL_DB._configTiers = config.model_tiers;
  }

  // ─── Step 1: Auto-install omo ───
  console.log(`\n[omf] ─── Step 1: Checking omo installation ───`);
  const omoCheck = ensureOmoInstalled();
  console.log(`[omf] ${omoCheck.message}`);
  if (!omoCheck.installed) {
    console.log(`[omf] WARNING: Could not verify/add omo installation`);
  }

  // ─── Step 2: Discover all models via CLI ───
  console.log(`\n[omf] ─── Step 2: Discovering models via CLI ───`);
  const apiModelObjs = await discoverProviderApiModels(configDir, true);
  const allModelIds = apiModelObjs.map(m => m.id);

  console.log(`[omf] Models discovered via CLI: ${allModelIds.length}`);
  if (allModelIds.length === 0) {
    console.log(`[omf] No models found. Ensure OpenCode is installed and 'opencode' is in PATH.`);
    return false;
  }

  // ─── Step 3: Filter by availability (exclude paid models by default) ───
  console.log(`\n[omf] ─── Step 3: Filtering by availability ───`);

  const activeFree = apiModelObjs.filter(m =>
    m.status === 'active' && (!m.cost || (m.cost.input === 0 && m.cost.output === 0))
  );
  const activePaid = apiModelObjs.filter(m =>
    m.status === 'active' && m.cost && (m.cost.input > 0 || m.cost.output > 0)
  );
  const inactiveModels = apiModelObjs.filter(m => m.status && m.status !== 'active');
  const statusUnknown = apiModelObjs.filter(m => !m.status);

  const nFree = activeFree.length;
  const nPaid = activePaid.length;
  const nInactive = inactiveModels.length;
  const nUnknown = statusUnknown.length;

  console.log(`[omf]   ✓ Free+Active:  ${nFree}`);
  if (nPaid > 0)    console.log(`[omf]   💰 Paid:         ${nPaid} (excluded by default)`);
  if (nInactive > 0) console.log(`[omf]   ✗ Inactive:     ${nInactive}`);
  if (nUnknown > 0)  console.log(`[omf]   ? Unknown:      ${nUnknown}`);

  // Exclude paid models (non-interactive default)
  let candidateModels = [...activeFree, ...statusUnknown];
  console.log(`[omf]   → Paid models excluded (non-interactive mode)`);

  if (nInactive > 0) {
    console.log(`[omf] Excluded ${nInactive} inactive model(s)`);
  }

  let candidateIds = candidateModels.map(m => m.id);
  console.log(`[omf] Available models: ${candidateIds.length}`);

  if (candidateIds.length === 0) {
    console.log(`[omf] No available models after filtering. Aborting.`);
    return false;
  }

  // ─── Step 3b: Real API probe to verify models actually respond ───
  if (_pluginCtx && candidateModels.length > 0) {
    console.log(`\n[omf] ─── Step 3b: Probing model availability (real API calls) ───`);
    candidateModels = await probeAvailableModels(candidateModels, _pluginCtx);
    if (candidateModels.length === 0) {
      console.log(`[omf] No models passed the probe. Aborting.`);
      return false;
    }
    // Recalculate candidateIds from probed models
    candidateIds = candidateModels.map(m => m.id);
  } else if (!_pluginCtx) {
    console.log(`[omf] ─── Step 3b: Skipping probe (no plugin context — running standalone) ───`);
  }

  // ─── Step 4: Read standard omo config + update to available models ───
  console.log(`\n[omf] ─── Step 4: Reading standard omo config & updating models ───`);

  // Get standard omo models (source of truth for all agents + categories)
  const standardOmoModels = getStandardOmoModels();
  console.log(`[omf] Standard omo models: ${standardOmoModels.length}`);
  standardOmoModels.forEach(m => console.log(`[omf]   • ${m}`));

  // Find omo config path for writing back replacements
  const omoPossiblePaths = [
    join(process.env.APPDATA || '', 'opencode', 'oh-my-opencode.json'),
    join(process.env.HOME || '/root', '.config', 'opencode', 'oh-my-opencode.json'),
    join(process.env.HOME || '/root', '.config', 'opencode', 'oh-my-openagent.json'),
  ];
  let omoConfigPath = null;
  for (const p of omoPossiblePaths) {
    if (existsSync(p)) { omoConfigPath = p; break; }
  }

  // Apply standard config → strip version → replace with free equivalents
  // Build the replacement map from STANDARD_OMO_CONFIG directly
  const availableSet = new Set(candidateIds);
  const replaced = [];

  // Strip version suffix: claude-opus-4-6 → claude-opus (handles both with and without provider)
  const stripVersion = (modelId) => {
    const parts = modelId.split('/');
    if (parts.length === 2) {
      // Has provider prefix: axon/claude-opus-4-6 → axon/claude-opus
      return `${parts[0]}/${parts[1].replace(/-\d+(\.\d+)*(-\w+)?$/, '')}`;
    } else {
      // No provider: claude-opus-4-6 → claude-opus
      return modelId.replace(/-\d+(\.\d+)*(-\w+)?$/, '');
    }
  };

  // Build replacement map from standard config
  const agentReplacements = {};
  const categoryReplacements = {};

  // Provider prefix map for models without provider in standard config
  const PROVIDER_PREFIX_MAP = {
    'claude-opus-4-6': 'axon',
    'claude-sonnet-4-6': 'axon',
    'gpt-5.4': 'opencode',
    'gpt-5.4-mini': 'opencode',
    'minimax-m2.7': 'nvidia/minimaxai',
    'grok-code-fast-1': 'nvidia/xai',
    'gemini-3.1-pro': 'nvidia/google',
    'gemini-3-flash': 'nvidia/google',
  };

  // Fallback mapping for models with no direct free equivalent
  const FALLBACK_MAP = {
    'gpt-5.4': 'opencode/big-pickle',
    'grok-code-fast-1': 'opencode/deepseek-v4-flash-free',
    'gpt-5.4-mini': 'opencode/mimo-v2.5-free',
  };

  if (STANDARD_OMO_CONFIG.agents) {
    for (const [name, model] of Object.entries(STANDARD_OMO_CONFIG.agents)) {
      if (!availableSet.has(model)) {
        let freeCandidate = null;
        
        // Try stripping version from the model ID
        const cleaned = stripVersion(model);
        if (cleaned !== model && availableSet.has(cleaned)) {
          freeCandidate = cleaned;
        } else {
          // No provider prefix — try matching against available models
          // First, try with known provider prefix
          const knownPrefix = PROVIDER_PREFIX_MAP[model];
          if (knownPrefix) {
            const prefixed = `${knownPrefix}/${model.replace(/-\d+(\.\d+)*(-\w+)?$/, '')}`;
            if (availableSet.has(prefixed)) {
              freeCandidate = prefixed;
            }
          }
          
          // If no prefix match, try fallback map (for models with no direct equivalent)
          if (!freeCandidate && FALLBACK_MAP[model]) {
            if (availableSet.has(FALLBACK_MAP[model])) {
              freeCandidate = FALLBACK_MAP[model];
            }
          }
          
          // Fallback: search all available models by name
          if (!freeCandidate) {
            const cleanedName = model.replace(/-\d+(\.\d+)*(-\w+)?$/, '');
            for (const avail of candidateIds) {
              if (avail.endsWith('/' + cleanedName) || avail === cleanedName) {
                freeCandidate = avail;
                break;
              }
            }
          }
        }
        
        if (freeCandidate) {
          agentReplacements[name] = { from: model, to: freeCandidate };
          replaced.push({ from: model, to: freeCandidate });
        }
      }
    }
  }

  if (STANDARD_OMO_CONFIG.categories) {
    for (const [name, model] of Object.entries(STANDARD_OMO_CONFIG.categories)) {
      if (!availableSet.has(model)) {
        let freeCandidate = null;
        
        const cleaned = stripVersion(model);
        if (cleaned !== model && availableSet.has(cleaned)) {
          freeCandidate = cleaned;
        } else {
          const knownPrefix = PROVIDER_PREFIX_MAP[model];
          if (knownPrefix) {
            const prefixed = `${knownPrefix}/${model.replace(/-\d+(\.\d+)*(-\w+)?$/, '')}`;
            if (availableSet.has(prefixed)) {
              freeCandidate = prefixed;
            }
          }
          
          if (!freeCandidate && FALLBACK_MAP[model]) {
            if (availableSet.has(FALLBACK_MAP[model])) {
              freeCandidate = FALLBACK_MAP[model];
            }
          }
          
          if (!freeCandidate) {
            const cleanedName = model.replace(/-\d+(\.\d+)*(-\w+)?$/, '');
            for (const avail of candidateIds) {
              if (avail.endsWith('/' + cleanedName) || avail === cleanedName) {
                freeCandidate = avail;
                break;
              }
            }
          }
        }
        
        if (freeCandidate) {
          categoryReplacements[name] = { from: model, to: freeCandidate };
          replaced.push({ from: model, to: freeCandidate });
        }
      }
    }
  }

  // Write replacements back to oh-my-opencode.json
  if (omoConfigPath && replaced.length > 0) {
    try {
      const raw = readFileSync(omoConfigPath, 'utf-8');
      const omoConfig = JSON.parse(raw);

      if (omoConfig.agents) {
        for (const [name, repl] of Object.entries(agentReplacements)) {
          if (omoConfig.agents[name] && omoConfig.agents[name].model) {
            omoConfig.agents[name].model = repl.to;
          }
        }
      }

      if (omoConfig.categories) {
        for (const [name, repl] of Object.entries(categoryReplacements)) {
          if (omoConfig.categories[name] && omoConfig.categories[name].model) {
            omoConfig.categories[name].model = repl.to;
          }
        }
      }

      writeFileSync(omoConfigPath, JSON.stringify(omoConfig, null, 2) + '\n', 'utf-8');
    } catch (e) {
      console.log(`[omf] Failed to write omo config: ${e.message}`);
    }
  }

  if (replaced.length > 0) {
    console.log(`\n[omf] Replaced ${replaced.length} standard model(s) with free equivalents:`);
    replaced.forEach(r => console.log(`[omf]   ${r.from} → ${r.to}`));
  } else {
    console.log(`[omf] All standard omo models are available — no replacement needed.`);
  }

  // Final omo models = read from oh-my-opencode.json after replacements
  const omoModels = getOmoRequiredModels(configDir);
  console.log(`\n[omf] Final omo models: ${omoModels.length}`);
  omoModels.forEach(m => console.log(`[omf]   • ${m}`));

  // ─── Step 5: Build deep fallback chain (≥3 fallback hops per model) ───
  console.log(`\n[omf] ─── Step 5: Building fallback chain ───`);

  OMO_MODEL_DB._configTiers = config.model_tiers || null;
  const strategy = config.fallback_chain?.strategy || 'performance';
  const { chain, links, head } = buildDeepFallbackChain(candidateIds, omoModels, { strategy });

  if (chain.length === 0) {
    console.log(`[omf] No chain could be built. Aborting.`);
    return false;
  }

  console.log(`[omf] Chain built (${chain.length} models, strategy: ${strategy}):`);
  chain.forEach((m, i) => {
    const tierInfo = OMO_MODEL_DB.classify(m);
    const next = links[m];
    const tierLabel = tierInfo ? ` (${tierInfo.tier})` : '';
    const nextLabel = next ? ` → ${next}` : ' ⏹';
    console.log(`[omf] ${i + 1}) ${m}${tierLabel}${nextLabel}`);
  });

  // Verify all omo models are in chain
  const missingOmo = omoModels.filter(m => !chain.includes(m));
  if (missingOmo.length > 0) {
    console.log(`[omf] WARNING: ${missingOmo.length} omo model(s) not in chain`);
  } else {
    console.log(`[omf] All ${omoModels.length} omo models are in the chain ✓`);
  }

  // ─── Step 6: Auto-apply (no prompt) ───
  console.log(`\n[omf] Applying configuration...`);

  config.model_tiers = config.model_tiers || {};
  config.fallback_models = config.fallback_models || {};
  config.fallback_models.default = chain;
  config.fallback_models.agents = config.fallback_models.agents || {};
  config.fallback_chain = config.fallback_chain || {};
  config.fallback_chain.strategy = strategy;
  config.fallback_chain.head = head;
  config.fallback_chain.links = links;

  const configPath = join(configDir, 'omf.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  console.log(`[omf] Config saved to ${configPath}`);

  return true;
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
      case 'optimize':
      case 'auto': {
        const configDir = getOpenCodeConfigDir();
        const config = loadConfig(configDir);
        const strategy = (args && args[1]) || config.fallback_chain?.strategy || 'performance';
        const valid = ['performance', 'price', 'feature', 'comprehensive'];
        if (!valid.includes(strategy)) {
          console.log(`[omf] Invalid strategy "${strategy}". Choose: ${valid.join(', ')}`);
          return { handled: true };
        }
        config.fallback_chain = config.fallback_chain || {};
        config.fallback_chain.strategy = strategy;
        await tuiAutoOptimize(configDir, config);
        break;
      }
      case 'status':
      case 'show': {
        const configDir = getOpenCodeConfigDir();
        const config = loadConfig(configDir);
        await showStatus(config);
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
  TIER_SCORES,
  classifyByCost,
  buildFallbackChain,
  discoverProviderApiModels,
  discoverAgentEntries,
  discoverProviderModels,
  showStatus,
  tuiAutoOptimize,
  tuiInit,
  runInit,
  runTUI,
  handleCommand,
  EVOLVE_DEFAULTS,
  getEvolveLogPath,
  logModelOutcome,
  recordModelOutcome,
  analyzeModelPerformance,
  discoverNewModels,
  evolveFallbackChain,
};
export default plugin;
