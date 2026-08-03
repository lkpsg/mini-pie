# mini-pie 示例

[English](./README.md) | 简体中文

这些示例通过一个小型文本摘要应用介绍 mini-pie，并按照单 Agent、Agent Hook、可恢复 Graph 的顺序逐步增加能力。

## 开始之前

安装依赖并构建仓库：

```bash
npm install --ignore-scripts
npm run build
```

填写仓库根目录的 `.env`：

```dotenv
OPENAI_BASE_URL=https://your-service.example/v1
OPENAI_API_KEY=your-api-key
OPENAI_MODEL=your-model-name
```

示例配置使用 `openai-completions`，适用于兼容 OpenAI Chat Completions 的服务。如果服务实现的是 Responses API，请将 [`mini-pie.yaml`](./mini-pie.yaml) 中的 `api` 改为 `openai-responses`。

在不发起模型请求的情况下列出已注册 Unit：

```bash
npm run dev -- units --config examples/mini-pie.yaml
```

## 1. 最小 Agent

[`units/summary-agent/unit.yaml`](./units/summary-agent/unit.yaml) 只包含模型引用、Prompt 和轮次限制：

```yaml
kind: agent
model: default
systemPrompt:
  file: ./prompts/system.md
userPrompt: "Summarize this text:\n\n{{input}}"
maxTurns: 4
```

将它作为 Unit 运行：

```bash
npm run dev -- run summary-agent \
  "mini-pie combines deterministic code and model-driven agents in one graph." \
  --config examples/mini-pie.yaml
```

需要流式输出和对话 Session 时，可以使用直接 Agent 命令：

```bash
npm run dev -- agent summary-agent \
  "Summarize why explicit data flow helps debugging." \
  --config examples/mini-pie.yaml
```

## 2. 带 Hook 的 Agent

[`units/summary-with-hooks/unit.yaml`](./units/summary-with-hooks/unit.yaml) 增加了两个确定性代码步骤：

```text
输入 -> normalizeInput -> Agent -> formatOutput -> 结构化输出
```

`before` Hook 在模型调用前标准化空白字符，`after` Hook 将模型文本转换为包含 `summary` 和 `characters` 字段的对象。二者都是定义在 [`src/hooks.ts`](./units/summary-with-hooks/src/hooks.ts) 中的普通 TypeScript Code Node。

通过支持 Graph 的 `run` 命令运行 Agent，确保 Hook 会被执行：

```bash
npm run dev -- run summary-with-hooks \
  "  mini-pie keeps prompts, code, and configuration in one unit.  " \
  --config examples/mini-pie.yaml --json
```

这个示例展示了 mini-pie 鼓励的职责边界：模型负责语义摘要，代码负责可预测的输入和输出处理。

## 3. 带人工审核的 Graph

[`units/reviewed-summary/unit.yaml`](./units/reviewed-summary/unit.yaml) 将相同任务扩展成一个线性 Graph：

```text
输入 -> prepare Code Node -> summary Agent -> 审核 -> finish Code Node -> 输出
```

该 Graph 展示了：

- 使用显式边表示控制流；
- 使用 `$ref` 绑定表示数据流；
- 使用 `statePatch` 共享 Graph State；
- Agent 自动重试；
- 持久化人工审核 Checkpoint；
- 在后续命令或另一个进程中恢复执行。

启动 Graph：

```bash
npm run dev -- run reviewed-summary \
  "A checkpoint lets an application inspect or replace an Agent result before execution continues." \
  --config examples/mini-pie.yaml
```

命令会在 Agent 执行后暂停并输出 Run ID。使用该 ID 批准暂存摘要：

```bash
npm run dev -- resume <run-id> approve --config examples/mini-pie.yaml
```

如果需要在继续前替换摘要，可以使用 `edit` 并传入 JSON 字符串：

```bash
npm run dev -- resume <run-id> edit '"A human-edited summary."' \
  --config examples/mini-pie.yaml
```

持久化 JSONL Run 存储在 `.mini-pie/runs/` 下。

## 文件之间的关系

```text
examples/mini-pie.yaml                 注册模型和 Unit
examples/units/summary-agent/          最小可复用 Agent
examples/units/summary-with-hooks/     Agent 加前后置代码
examples/units/reviewed-summary/       由代码和 Agent 组成的 Graph
```

三个示例使用同一个 Runtime 和同一个 `runUnit()` API。随着需求增长，只需要继续组合 `agent` 和 `code` 两种原语，而不需要切换到另一套 Workflow 抽象。
