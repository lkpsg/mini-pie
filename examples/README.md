# mini-pie examples

English | [简体中文](./README.zh-CN.md)

These examples introduce mini-pie through one small text-summarization application. They progress from a single Agent to Agent Hooks and then to a resumable Graph.

## Before you start

Install and build the repository:

```bash
npm install --ignore-scripts
npm run build
```

Fill in the root `.env` file:

```dotenv
OPENAI_BASE_URL=https://your-service.example/v1
OPENAI_API_KEY=your-api-key
OPENAI_MODEL=your-model-name
```

The example configuration uses `openai-completions`, which works with OpenAI-compatible Chat Completions services. Change `api` in [`mini-pie.yaml`](./mini-pie.yaml) to `openai-responses` if the service implements the Responses API instead.

List the registered units without making a model request:

```bash
npm run dev -- units --config examples/mini-pie.yaml
```

## 1. Minimal Agent

[`units/summary-agent/unit.yaml`](./units/summary-agent/unit.yaml) contains only a model reference, prompts, and a turn limit:

```yaml
kind: agent
model: default
systemPrompt:
  file: ./prompts/system.md
userPrompt: "Summarize this text:\n\n{{input}}"
maxTurns: 4
```

Run it as a unit:

```bash
npm run dev -- run summary-agent \
  "mini-pie combines deterministic code and model-driven agents in one graph." \
  --config examples/mini-pie.yaml
```

Use the direct Agent command when streaming and conversation sessions are needed:

```bash
npm run dev -- agent summary-agent \
  "Summarize why explicit data flow helps debugging." \
  --config examples/mini-pie.yaml
```

## 2. Agent with Hooks

[`units/summary-with-hooks/unit.yaml`](./units/summary-with-hooks/unit.yaml) adds two deterministic code steps:

```text
input -> normalizeInput -> Agent -> formatOutput -> structured output
```

The `before` Hook normalizes whitespace before the model call. The `after` Hook converts the model text into an object with `summary` and `characters` fields. Both are ordinary TypeScript Code Nodes defined in [`src/hooks.ts`](./units/summary-with-hooks/src/hooks.ts).

Run the Agent through the graph-aware `run` command so its Hooks execute:

```bash
npm run dev -- run summary-with-hooks \
  "  mini-pie keeps prompts, code, and configuration in one unit.  " \
  --config examples/mini-pie.yaml --json
```

This example shows the boundary mini-pie encourages: the model performs semantic summarization, while code handles predictable input and output processing.

## 3. Graph with Human Review

[`units/reviewed-summary/unit.yaml`](./units/reviewed-summary/unit.yaml) expands the same task into a linear Graph:

```text
input -> prepare Code Node -> summary Agent -> review -> finish Code Node -> output
```

The Graph demonstrates:

- explicit edges for control flow;
- `$ref` bindings for data flow;
- a `statePatch` for shared Graph State;
- automatic Agent retry;
- a persisted review checkpoint;
- resuming in a later command or process.

Start the Graph:

```bash
npm run dev -- run reviewed-summary \
  "A checkpoint lets an application inspect or replace an Agent result before execution continues." \
  --config examples/mini-pie.yaml
```

The command pauses after the Agent and prints a Run ID. Approve the staged summary with that ID:

```bash
npm run dev -- resume <run-id> approve --config examples/mini-pie.yaml
```

To replace the summary before continuing, use `edit` and pass a JSON string value:

```bash
npm run dev -- resume <run-id> edit '"A human-edited summary."' \
  --config examples/mini-pie.yaml
```

The persisted JSONL run is stored under `.mini-pie/runs/`.

## How the files fit together

```text
examples/mini-pie.yaml                 registers the model and units
examples/units/summary-agent/          minimal reusable Agent
examples/units/summary-with-hooks/     Agent plus before/after code
examples/units/reviewed-summary/       Graph composed from code and an Agent
```

The three examples use the same runtime and the same `runUnit()` API. Complexity grows by composing the two primitives, `agent` and `code`, rather than switching to another workflow abstraction.
