# omf — Oh My Fallback

<p align="center">
  <a href="README.md"><strong>🇬🇧 English</strong></a> ·
  <a href="README.zh.md"><strong>🇨🇳 中文</strong></a>
</p>

**OpenCode 智能模型回退编排引擎。**

当模型失败（错误、空响应、拒绝回答、额度超限）时，`omf` 不是简单线性重试——它**遍历预计算的链表**，在 O(1) 时间内找到下一个最优模型，跳过冷却中的模型、绕过熔断的 provider、保留完整的对话上下文。

---

## 为什么用 omf？

| 问题 | omf 方案 |
|---|---|
| 💥 模型返回 429/5xx | 自动中止 + **O(1) 链表**回退到下一模型 |
| 🤐 模型拒绝或返回空 | 内容级检测（空响应、拒绝模式、额度超限、自定义正则） |
| 🔥 Provider 宕机连带所有模型不可用 | 熔断器——跳过整个 provider N 秒 |
| 📉 模型质量未知 | 自进化追踪实际调用结果，自动重排回退链 |
| 🎯 手动与 agent 需要不同回退链 | `omf.json` 中按 agent 覆盖，零耦合 |
| 🧠 "哪个模型该回退给谁？" | 4 种策略——性能、价格、功能匹配、综合 |

---

## 工作原理

```
任意会话（手动或 agent）
     │
     ├── 模型失败（429/5xx/空响应/拒绝/额度超限）
     │
     ▼
┌─────────────────────┐
│  omf 检测流水线      │
│  • HTTP 状态码       │
│  • 响应内容检查      │
│  • 自定义正则        │
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  健康与安全          │
│  • 单模型冷却        │
│  • Provider 熔断    │
│  • 健康检查          │
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  链表遍历 O(1)       │
│  回退决议             │
│  （无线性扫描）      │
└────────┬────────────┘
         │
         ▼
    用下一模型重新发起
    → 对话继续
```

### 链表架构

传统回退链使用平面数组——每次回退都从索引 0 扫描，重试已经失败过的模型。`omf` 使用**链表**：

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

每个模型只指向**一个回退目标**。解析复杂度 O(1)——无需索引扫描，5 跳内无重复重试。构建时自动检测循环；若发现循环，自动回退到 `performance` 策略。

---

## 4 种回退策略

`omf` 对 OpenCode 安装中的**所有模型打分**（通过 `opencode models` CLI 发现 118+ 个模型），按优先级构建链表。

| 策略 | 排序依据 | 适用场景 |
|---|---|---|
| `performance` | 能力层级分（premium > balanced > fast > cheap） | 追求最高响应质量 |
| `price` | 层级分取反（cheap 优先） | 成本敏感的负载 |
| `feature` | 能力重叠度 + 层级对齐度 | 回退后能力不降级 |
| `comprehensive` | 40% 性能 + 30% 价格 + 30% 功能 | 各项均衡 |

通过 `/omf optimize <strategy>` 或在 `omf.json` → `fallback_chain.strategy` 中设置。

```bash
# 性能优先（默认）
/omf optimize

# 价格优化
/omf optimize price

# 功能匹配
/omf optimize feature

# 综合均衡
/omf optimize comprehensive
```

### Feature 策略详解

`feature` 策略通过解析模型 ID 推断能力：
- **vision**：图像生成、视觉语言模型
- **code**：coder/codex/codeqwen 变体
- **reasoning**：reasoner/reasoning 模型
- **fast**：flash/haiku/fast/mini/nano 变体
- **streaming + tools**：所有非 embedding 模型

与链头共享 60%+ 能力的模型得分最高。回退后能力不降级——不只看层级。

---

## 安装

### 在线安装（一行命令）

```bash
# 预览（不做任何更改）
curl -fsSL https://raw.githubusercontent.com/fifaliao/omf/main/install.sh | bash

# 应用更改
curl -fsSL https://raw.githubusercontent.com/fifaliao/omf/main/install.sh | bash -s -- --apply
```

脚本自动检测在线模式，克隆到 `~/.config/opencode/plugins/omf`（Linux/macOS）或 `%APPDATA%\opencode\plugins\omf`（Windows），注册插件并创建默认配置。

### 本地安装

```bash
cd /path/to/omf
chmod +x install.sh
./install.sh          # 预览
./install.sh --apply  # 应用
```

或在 `~/.config/opencode/opencode.json` 中手动添加：
```json
{ "plugin": ["file:///path/to/omf"] }
```
重启 OpenCode，查看 `[omf]` 日志确认加载成功。

### 交互式配置（TUI）

```bash
./install.sh --configure --apply
```

或编程调用：
```js
import { runTUI } from 'omf';
await runTUI();                  // 默认配置目录
await runTUI('/custom/path');    // 自定义目录
```

TUI 支持：
- **显示状态** — 查看回退链、策略、按 agent 覆盖
- **自动优化** — 选择策略，构建链表，持久化
- **手动配置链** — 逐个输入模型并验证格式
- **编辑选项** — 修改 max_retries、cooldown、auto_optimize、检测设置
- **初始化（Init）** — 发现所有 agent 并配置按 agent 回退链

---

## 聊天内命令 (`/omf`)

由 `install.sh --apply` 自动安装。omf skill 教导 OpenCode 直接在聊天中编辑配置：

```
/omf status                  # 显示当前配置
/omf optimize [strategy]     # 自动发现 118+ 模型，构建链表
/omf add axon/deepseek       # 追加模型到链尾
/omf remove 3                # 删除第 3 个模型
/omf set 2 axon/gpt-5.4      # 替换第 2 个模型
/omf retries 5               # 设置 max_retries
/omf cooldown 30             # 设置 cooldown_seconds
/omf auto                    # 开关 auto_optimize
/omf evolve on               # 启用自进化
/omf evolve status           # 查看模型性能统计
```

---

## 自进化

默认启用。追踪模型调用结果（成功/失败/延迟），自动调整回退链：

- **晋升**成功率达 70%+ 的模型到链顶
- **降级**失败率达 30%+ 的模型到链底
- **发现**配置中出现的新模型并自动追加
- 数据存储在 `evolve.jsonl`

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

## 自动优化

在 `omf.json` 中设置 `auto_optimize: true` 可在每次插件加载时自动重建回退链：

```json
{ "options": { "auto_optimize": true } }
```

使用 `opencode models` CLI 发现所有模型，按配置的策略执行 `buildFallbackChain()`，写入并生效。

---

## 配置

`omf.json` 位于平台对应的配置目录（Linux/macOS: `~/.config/opencode/`，Windows: `%APPDATA%\opencode\`）。

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

| 选项 | 描述 | 默认值 |
|---|---|---|
| `fallback_models.default` | 默认回退链（平面数组，用于展示） | — |
| `fallback_models.agents` | 按 agent 覆盖（仅存于 `omf.json`） | `{}` |
| `fallback_chain.strategy` | 排序策略：performance/price/feature/comprehensive | `performance` |
| `fallback_chain.head` | 链表头（第一个尝试的模型） | 链中首个模型 |
| `fallback_chain.links` | 链表：每个模型 → 它的回退目标 | — |
| `max_retries` | 每会话最大回退次数 | 3 |
| `cooldown_seconds` | 失败模型冷却秒数 | 30 |
| `retry_on_errors` | 触发回退的 HTTP 状态码 | `[429, 500, 502, 503, 504]` |
| `provider_cooldown_seconds` | 熔断：同一 provider 所有模型跳过秒数 | 60 |
| `notify_on_fallback` | 回退时显示 toast | `true` |
| `detect.empty` | 检测空响应 | `true` |
| `detect.refusal` | 检测拒绝模式（"I'm sorry..."） | `true` |
| `detect.usage_limit` | 检测额度超限（额度失败、余额不足） | `true` |
| `detect.custom_patterns` | 用户自定义失败检测正则数组 | `[]` |

### 按 agent 设置回退

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

失败时，`omf` 读取该 agent 的覆盖链。没有覆盖则使用默认链。

---

## 插件 API

```typescript
export default async function plugin(
  input: PluginInput,
  options?: { configDir?: string }
): Promise<PluginHooks>
```

### 处理的事件

| 事件 | 行为 |
|---|---|
| `message.updated` | 错误/内容检测 → 回退 |
| `session.error` | 会话级错误（被动，委托给 `message.updated`） |

### 检测流水线

```
message.updated
    ├── HTTP 状态码: 429, 5xx? ───────────→ 回退
    ├── 空响应? ──────────────────────────→ 回退
    ├── 拒绝模式? ────────────────────────→ 回退
    ├── 额度超限? ────────────────────────→ 回退
    └── 自定义正则匹配? ──────────────────→ 回退

回退决议（链表）:
    ├── 通过 links[current] 前进
    ├── 跳过冷却中的模型
    ├── 跳过熔断 provider 的模型
    └── 用下一模型重新发起（保留上下文）
```

### 导出函数

| 函数 | 描述 |
|---|---|
| `runTUI(configDir?)` | 启动交互式 TUI 配置 |
| `handleCommand({name, args})` | 处理 `/omf` 命令 |
| `buildFallbackChain(models, strategy)` | 评分 + 排序 + 构建链表（4 种策略） |
| `discoverAvailableModels(configDir)` | 从 `opencode models` CLI + 配置文件发现模型 |
| `discoverProviderApiModels(configDir)` | 通过 `opencode models` CLI 发现模型（唯一方法） |
| `discoverAgentEntries(configDir)` | 从 `oh-my-openagent.json` 发现 agent |
| `tuiInit(configDir, config)` | 交互式初始化：发现并配置所有 agent |
| `tuiAutoOptimize(configDir, config)` | 带策略选择的自动优化 |
| `OMO_MODEL_DB.classify(modelId)` | 将模型分类到能力层级 |
| `OMO_MODEL_DB.rank(models)` | 按层级分排序 |
| `OMO_MODEL_DB.optimize(models, max)` | 构建优化链（旧版，推荐使用 `buildFallbackChain`） |
| `logModelOutcome(configDir, model, success, latency, errorCode)` | 记录调用结果到 `evolve.jsonl` |
| `analyzeModelPerformance(configDir, minObservations)` | 分析进化数据 |
| `evolveFallbackChain(configDir, config)` | 运行自进化 |

---

## 开发

```bash
git clone <仓库地址>
cd omf
# 编辑 index.js
# 重启 OpenCode 测试
```

**无构建步骤。无测试。无 TypeScript。** 纯 ES Module。零外部依赖——永远不需要 `npm install`。

查看 `[omf]` 前缀的日志输出以调试。

---

## 许可

MIT
