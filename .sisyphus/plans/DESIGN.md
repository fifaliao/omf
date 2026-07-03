# omf 插件设计文档

> 基于 `index.js`（1683 行）完整代码审计，2026-06-01

---

## 1. 架构总览

### 模块划分（当前）

```
index.js（全量 1683 行）
├── 配置加载           ~270 行 (1-273)
│   ├── 跨平台路径     getOpenCodeConfigDir()
│   ├── model 能力库   OMO_MODEL_DB
│   ├── 配置合并       deepMerge()
│   └── 配置加载       loadConfig()
├── 模型发现+评分      ~190 行 (273-460)
│   ├── CLI 发现       discoverProviderApiModels()
│   ├── 能力推断       inferModelCapabilities()
│   └── 回退链构建     buildFallbackChain()
├── 自动优化           ~90 行 (460-550)
│   └── autoOptimizeConfig()
├── 自进化             ~190 行 (558-745)
│   ├── logModelOutcome()
│   ├── analyzeModelPerformance()
│   ├── discoverNewModels()
│   └── evolveFallbackChain()
├── 错误检测           ~130 行 (745-880)
│   ├── extractAgentName()
│   ├── extractStatusCode()
│   ├── isRetryableError()
│   ├── isAbnormalResponse()
│   └── parseModelString()
├── 插件核心           ~300 行 (880-1175)
│   ├── sessionStates Map（状态机）
│   ├── tryManualFallback()
│   └── event 处理器
├── TUI 交互           ~250 行 (1175-1430)
│   ├── readLine()
│   ├── showStatus()
│   ├── tuiAutoOptimize()
│   └── tuiInit()
└── 命令处理           ~250 行 (1430-1683)
    ├── handleCommand()
    └── showHelp()
```

---

## 2. 数据流

### 事件 → 回退 完整路径

```
message.updated (session.status) 事件
    │
    ├── 路径 A: 错误检测
    │   ├── isRetryableError()
    │   │   ├── extractStatusCode()  → 匹配 retry_on_errors
    │   │   ├── 排除 ProviderAuthError, MessageAbortedError
    │   │   └── 文本匹配: "too many requests" / "429" / "rate limit"
    │   │
    │   └── 命中 → tryManualFallback()
    │
    ├── 路径 B: 异常内容检测
    │   ├── isAbnormalResponse()
    │   │   ├── detectConfig.empty?          → 空响应
    │   │   ├── isUsageLimitResponse(text)   → 额度超限
    │   │   ├── REFUSAL_PATTERNS match       → 拒绝模式
    │   │   └── detectConfig.custom_patterns → 自定义正则
    │   │
    │   └── 命中 → tryManualFallback()
    │
    └── 路径 C: session.status retry 拦截
        ├── status.type === 'retry'
        ├── msg.match(/too many requests|.../)
        └── → tryManualFallback()
```

### Session 状态机

```
idle (初始)
  │
  │ getOrCreateSessionState()
  ▼
created (pending=false, attemptCount=0, currentFallbackModel=null)
  │
  │ event 触发 → tryManualFallback()
  ▼
fallback_in_progress (pending=true, attemptCount++)
  │
  ├── abort() + promptAsync() → 成功
  │   └── pending=false
  │
  ├── promptAsync() 抛出异常
  │   ├── failedModels.set(model, now)
  │   ├── failedProviders.set(provider, now)
  │   ├── pending=false
  │   └── 递归 tryManualFallback() ← 无指数退避
  │
  └── attemptCount >= max_retries
      └── sessionStates.delete(sessionID) → terminal: failed
```

---

## 3. 设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 模型发现 | `opencode models` CLI | 单一真相源，无需 SDK/HTTP 兜底 |
| 回退链结构 | 链表 + 平面数组并存 | 链表 O(1) 决议，平面数组用于 UI 展示 |
| 评分策略 | 4 种 (perf/price/feature/comprehensive) | 不同场景优化 |
| 能力推断 | 解析模型 ID (vision/code/reasoning...) | 无需外部 API |
| 循环检测 | 5 跳自环检查 | 构建时保证 |
| Session 状态 | Map  + pending 锁 | 防止并发回退 |
| 熔断器 | 按 provider 60s cooldown | 快速失败，不浪费重试 |

---

## 4. 已知问题

### 🔴 P0 — 必须修复

| # | 位置 | 问题 | 建议 |
|---|------|------|------|
| 1 | `index.js:1158-1159` | `session.status` 竞争条件：`pending=false` 重置在 `tryManualFallback` 之前 | 删除 `sessState.pending = false` 行 |
| 2 | `index.js:982` |  `models` 为空时 session state 泄露（留在 Map 中） |  `sessionStates.delete()` 再 return |
| 3 | `index.js:1167-1175` | `session.error` 处理器创建 state 但不触发回退 | 对齐 `message.updated` 流程 |

### 🟡 P1 — 架构

| # | 描述 | 影响 |
|---|------|------|
| 1 | 单文件 1683 行，建议拆 `lib/` + `tui/` | 可维护性 |
| 2 | `discoverAvailableModels` / `discoverAgentEntries` / `discoverProviderModels` 死代码 | 技术债 |
| 3 | TUI + 命令处理（~500 行）与插件核心耦合 | 关注点分离 |

### 🟢 P2 — 质量

| # | 描述 | 建议 |
|---|------|------|
| 1 | `abort()` 无错误处理 | 加 try-catch |
| 2 | 递归重试无指数退避 | `1000 * 2^attemptCount` |
| 3 | 链表条目缺失时静默 fallback | 加 `console.warn()` |
| 4 | 无状态转换日志 | 加 debug 级日志 |

---

## 5. 回退决议流程

```
tryManualFallback(sessionID)
    │
    ├── 1. pending? → return (防并发)
    │
    ├── 2. attemptCount >= max_retries? → delete state (终止)
    │
    ├── 3. 链表推进
    │   ├── first call  → head from fallback_chain
    │   └── subsequent  → links[current]
    │
    ├── 4. 平面数组扫描（健康检查 + 冷却 + 熔断）
    │   ├── per-model cooldown? → skip
    │   ├── provider circuit breaker? → skip
    │   └── health check (evolve data)? → skip
    │
    ├── 5. 命中 → pending=true, abort(), promptAsync()
    │   ├── 成功 → pending=false
    │   └── 失败 → log fallback + pending=false + 递归 retry
    │
    └── 6. 未命中 → delete state (无可用模型)
```

---

## 6. 建议重构方向

### 6a. 文件拆分

```
omf/
├── index.js              ← 插件入口 + event 处理（~300 行）
├── package.json
├── lib/
│   ├── config.js         ← loadConfig, deepMerge
│   ├── chain.js          ← buildFallbackChain, inferModelCapabilities
│   ├── discovery.js      ← discoverProviderApiModels (CLI)
│   ├── evolve.js         ← 自进化逻辑
│   ├── detect.js         ← isRetryableError, isAbnormalResponse
│   └── state.js          ← sessionStates, tryManualFallback
├── tui/
│   └── index.js          ← showStatus, tuiInit, tuiAutoOptimize
└── commands.js           ← handleCommand
```

### 6b. 事件处理器分离

```js
// event 处理器 → 策略模式
const strategies = {
  'message.updated': handleMessageUpdated,
  'session.status': handleSessionStatus,
  'session.error': handleSessionError,
};
```

### 6c. Session State 提取

```js
class SessionState {
  constructor(sessionID) { /* ... */ }
  canFallback() { /* pending + attempt check */ }
  advance(links) { /* linked list walk */ }
  onFallbackStart() { /* pending = true */ }
  onFallbackEnd() { /* pending = false */ }
  onFallbackFailed(model, providerID) { /* cooldown + cleanup */ }
}
```

---

## 7. 文件依赖图（当前 vs 建议）

```
当前:                           建议:
                              index.js ───┬── lib/config.js
index.js (all)                              ├── lib/chain.js
  ├── all 函数                               ├── lib/discovery.js
  ├── TUI                                    ├── lib/evolve.js
  └── commands                               ├── lib/detect.js
                                            ├── lib/state.js
                                            ├── tui/index.js
                                            └── commands.js
```

---

## 8. 配置 Schema

### `omf.json` 顶层键

| 键 | 必须 | 描述 |
|---|------|------|
| `fallback_models` | Y | 平面数组 + agents 覆盖 |
| `fallback_chain` | Y | 链表（strategy, head, links） |
| `options` | Y | retry, cooldown, detection, etc |
| `model_tiers` | N | 运行时持久化的模型层级 |
| `evolve` | N | 自进化配置 |