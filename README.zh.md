# omf — Oh My Fallback

<p align="center">
  <a href="README.md"><strong>🇬🇧 English</strong></a> ·
  <a href="README.zh.md"><strong>🇨🇳 中文</strong></a>
</p>

[OpenCode](https://opencode.ai) 的统一模型故障回退管理插件。

## 概述

`omf` 为 OpenCode 的**手动会话**提供自动模型回退功能。当您手动选择的模型返回可重试错误（429、5xx）时，`omf` 会自动中止失败的请求，并使用回退链中的下一个模型重新发起提示——整个过程不会丢失上下文。

对于**代理（agent）会话**，`omf` 将 `fallback_models` 注入 `oh-my-openagent.json`，由 [oh-my-opencode](https://github.com/code-yeongyu/oh-my-openagent) 的内置运行时回退机制处理重试。

## 工作原理

```
手动会话
  ┌──────────┐    429/5xx      ┌──────────────┐
  │ 模型 A   │ ──────────────→ │ omf 检测到   │
  │ (失败)   │                 │ 错误         │
  └──────────┘                 └──────┬───────┘
                                      │
                            ┌─────────▼─────────┐
                            │ 1. 健康预查        │
                            │    (evolve 数据)    │
                            │ 2. 熔断检查        │
                            │    (provider 级别)  │
                            └─────────┬─────────┘
                                      │
                            ┌─────────▼─────────┐
                            │ 中止失败的请求      │
                            └─────────┬─────────┘
                                      │
                            ┌─────────▼─────────┐
                            │ 用最健康的 fallback│
                            │ 模型重新发起提示    │
                            └─────────┬─────────┘
                                      │
                            ┌─────────▼─────────┐
                            │ 成功 → 对话继续    │
                            └───────────────────┘
```

## 安装

### 在线安装（一行命令）

直接从 GitHub 安装，无需本地克隆：

```bash
# 预览（不做任何更改）
curl -fsSL https://raw.githubusercontent.com/fifaliao/omf/main/install.sh | bash

# 应用更改
curl -fsSL https://raw.githubusercontent.com/fifaliao/omf/main/install.sh | bash -s -- --apply
```

脚本会自动检测在线模式，将仓库克隆到平台对应的插件目录（Linux/macOS 上为 `~/.config/opencode/plugins/omf`，Windows 上为 `%APPDATA%\opencode\plugins\omf`），注册插件，并创建默认配置。

### 本地安装（开发）

```bash
# 克隆/复制到本地后：
cd /path/to/omf
chmod +x install.sh
./install.sh          # 预览模式
./install.sh --apply  # 应用更改
```

或手动安装：

1. 添加到 `~/.config/opencode/opencode.json` 的插件数组：

```json
{
  "plugin": [
    "file:///path/to/omf",
    "...其他插件..."
  ]
}
```

2. 重启 OpenCode。

3. 查看日志中是否包含 `[omf]` 消息以确认加载成功。

### 交互式配置

使用 `--configure` 标志可以交互式地发现、测试和选择 fallback 模型：

```bash
./install.sh --configure --apply
```

该流程将：
1. **发现** — 从 OpenCode 配置文件（`oh-my-openagent.json`、`opencode.json`、`omf.json`）中读取模型
2. **测试** — 对每个模型进行轻量级 API 调用，验证其连通性
3. **展示** — 以表格形式显示测试结果（✅ 正常 / ❌ 失败 / ⚠️ 无密钥）
4. **选择** — 让你交互式地排列 fallback 链顺序
5. **写入** — 将优化后的配置保存到 `omf.json`

在非交互模式（CI/管道）下，会自动使用内置模型能力数据库生成优化链。

### 交互式配置（TUI）

TUI 配置屏幕使用 Node.js `readline` 打开交互式终端菜单。可通过编程方式调用：

```js
import { runTUI } from 'omf';
await runTUI(); // 使用默认配置目录
await runTUI('/custom/config/path'); // 自定义配置目录
```

或使用安装脚本的 `--configure` 标志获得相同的交互式流程：

```bash
./install.sh --configure --apply
```

TUI 支持：
- **显示状态** — 查看当前 fallback 链、按 agent 覆盖和选项
- **自动优化** — 从配置中发现模型并构建优化链
- **手动配置链** — 逐个输入模型并验证格式
- **编辑选项** — 修改 max_retries、cooldown、auto_optimize、notify、检测设置
- **初始化（Init）** — 发现所有 agent 和模型，配置每个 agent 的专属 fallback 链

### omf Skill（在聊天中配置）

由 `install.sh --apply` 自动安装。该 skill 教导 OpenCode 如何处理聊天中的 `/omf` 命令，通过文件编辑工具直接修改 `omf.json`。试试：

```
/omf status      # 显示当前配置
/omf optimize    # 自动发现并排序模型
/omf init        # 发现所有 agent 和模型，配置每个 agent 的专属 fallback 链
/omf add axon/deepseek  # 添加模型到链
/omf remove 3    # 删除第 3 个模型
/omf retries 5   # 设置 max_retries
/omf evolve on   # 启用自进化 fallback 链
/omf evolve status  # 查看每个模型的性能统计
```

### 自进化

默认启用。追踪模型调用结果（成功/失败/延迟），自动调整 fallback 链顺序：

- **晋升**成功率达 70% 以上的模型到链顶
- **降级**失败率达 30% 以上的模型到链底
- **发现**配置中新增的模型并自动追加
- 数据存储在配置目录的 `evolve.jsonl` 中

在 `omf.json` 中配置：

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

### 自动优化

在 `omf.json` 中设置 `auto_optimize: true` 可在每次插件加载时自动优化 fallback 链：

```json
{
  "options": {
    "auto_optimize": true
  }
}
```

启用后，omf 会按能力层级（premium > balanced > fast > cheap）对发现的模型进行排名，并在运行时调整 fallback 链。

### 手动配置

编辑 `omf.json` 配置文件（路径根据平台自动适配：Windows 上为 `%APPDATA%\opencode\`，Linux/macOS 上为 `~/.config/opencode/`）进行自定义：

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

| 选项 | 描述 | 默认值 |
|---|---|---|---|
| `fallback_models.default` | 手动会话的回退链 | 4 个模型 |
| `fallback_models.agents` | 按代理覆盖（写入 oh-my-openagent.json） | `{}` |
| `max_retries` | 每个会话的最大回退尝试次数 | 3 |
| `cooldown_seconds` | 重试失败模型前的冷却秒数 | 30 |
| `retry_on_errors` | 触发回退的 HTTP 状态码 | `[429, 500, 502, 503, 504]` |
| `notify_on_fallback` | 回退触发时显示 toast 通知 | `true` |
| `detect.empty` | 检测空响应并触发回退 | `true` |
| `detect.refusal` | 检测 AI 拒绝模式（"I'm sorry..."）并触发回退 | `true` |
| `detect.usage_limit` | 检测用量/额度超限（额度失败、余额不足等）并触发回退 | `true` |
| `detect.custom_patterns` | 用户自定义失败检测正则表达式数组 | `[]` |
| `health_check` | 回退前跳过近期高失败率的模型（基于 evolve 数据） | `true` |
| `provider_cooldown_seconds` | 熔断：同一 provider 失败后跳过其所有模型的秒数 | `60` |

### 按代理设置回退

要为特定代理设置回退模型，添加到 `agents` 对象中：

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

插件加载时，`omf` 将这些配置写入 `~/.config/opencode/oh-my-openagent.json`，由 oh-my-opencode 的原生回退机制处理代理会话。

## 插件 API

`omf` 导出一个匹配 OpenCode 插件签名的默认异步函数：

```typescript
export default async function plugin(
  input: PluginInput,
  options?: { configDir?: string }
): Promise<PluginHooks>
```

### 处理的事件

| 事件 | 行为 |
|---|---|---|
| `message.updated` | 1. 检测可重试错误（状态码、provider 错误）→ 触发回退 |
|  | 2. 检测异常响应（空响应、拒绝模式、额度超限、自定义模式）→ 触发回退 |
| `session.error` | 会话级错误检测（被动——委托给 `message.updated`） |

### 检测流水线

```
message.updated
    │
    ├── 错误检测: 可重试 HTTP 状态码? (429, 5xx) ──→ 回退
    │
    ├── 内容检测: 空响应? ──────────────────────────→ 回退
    │
    ├── 内容检测: 拒绝模式? ("I'm sorry...") ────────→ 回退
    │
    ├── 内容检测: 额度超限? (quota, 额度, 余额不足) ──→ 回退
    │
    └── 内容检测: 自定义模式? (用户定义的正则) ──────→ 回退

回退模型选择:
    │
    ├── 1. 单模型冷却: 跳过近期失败的模型
    │
    ├── 2. Provider 熔断: 跳过同一 provider 的所有模型
    │
    └── 3. 健康预检: 跳过近期高失败率的模型 (evolve.jsonl)
```

### 导出函数

| 函数 | 描述 |
|---|---|
| `runTUI(configDir?)` | 启动交互式 TUI 配置 |
| `handleCommand({name, args})` | 处理 `/omf` 命令 |
| `discoverAvailableModels(configDir)` | 从配置文件中发现所有模型 |
| `discoverAgentEntries(configDir)` | 从 oh-my-openagent.json 发现所有 agent 和 category |
| `discoverProviderModels(configDir)` | 从 opencode.json 发现 provider 定义的模型 |
| `tuiInit(configDir, config)` | 交互式初始化：发现并配置所有 agent 和模型 |
| `OMO_MODEL_DB.classify(modelStr)` | 将模型分类到能力层级 |
| `OMO_MODEL_DB.rank(models)` | 按能力层级对模型排序 |
| `OMO_MODEL_DB.optimize(models, max)` | 构建优化的 fallback 链 |
| `logModelOutcome(configDir, model, success, latency, errorCode)` | 记录模型调用结果到 evolve.jsonl |
| `analyzeModelPerformance(configDir, minObservations)` | 分析 evolve.jsonl 获取性能统计 |
| `evolveFallbackChain(configDir, config)` | 运行自进化调整 fallback 链 |

## 开发

```bash
git clone <仓库地址>
cd omf
# 编辑 index.js
# 重启 OpenCode 以测试更改
```

## 许可

MIT