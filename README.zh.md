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
  ┌──────────┐    429/5xx     ┌──────────────┐
  │ 模型 A   │ ─────────────→ │ omf 检测到   │
  │ (失败)   │                │ 错误         │
  └──────────┘                └──────┬───────┘
                                     │
                            ┌────────▼────────┐
                            │ 中止失败的请求   │
                            └────────┬────────┘
                                     │
                            ┌────────▼────────┐
                            │ 使用下一个模型   │
                            │ 重新发起提示     │
                            └────────┬────────┘
                                     │
                            ┌────────▼────────┐
                            │ 成功 → 对话继续  │
                            └─────────────────┘
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

脚本会自动检测在线模式，将仓库克隆到 `~/.config/opencode/plugins/omf`，注册插件，并创建默认配置。

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

### 配置

`omf` 在首次加载时会创建默认配置文件 `~/.config/opencode/omf.json`。编辑它以自定义：

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
|---|---|---|
| `fallback_models.default` | 手动会话的回退链 | 4 个模型 |
| `fallback_models.agents` | 按代理覆盖（写入 oh-my-openagent.json） | `{}` |
| `max_retries` | 每个会话的最大回退尝试次数 | 3 |
| `cooldown_seconds` | 重试失败模型前的冷却秒数 | 30 |
| `retry_on_errors` | 触发回退的 HTTP 状态码 | `[429, 500, 502, 503, 504]` |
| `notify_on_fallback` | 回退触发时显示 toast 通知 | `true` |

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
|---|---|
| `message.updated` | 检测助手消息中带有可重试状态码的错误 → 触发手动回退 |
| `session.error` | 会话级错误检测（被动——委托给 `message.updated`） |

## 开发

```bash
git clone <仓库地址>
cd omf
# 编辑 index.js
# 重启 OpenCode 以测试更改
```

## 许可

MIT