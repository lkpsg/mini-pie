# mini-pie

A minimal, headless TypeScript agent and graph framework built on [Pi](https://github.com/earendil-works/pi).

mini-pie keeps Pi's streaming agent loop, state model, provider adapters, and coding tools. It adds a small configuration layer for reusable agent units and a graph runtime made from only two executable node types: `agent` and `code`.

There is no UI, server, database, MCP layer, expression language, or OS sandbox.

## Features

- Define a standalone agent with a model, system prompt, user prompt, and tools.
- Register agents and graphs from self-contained `units/<name>/` directories.
- Run code before or after an agent through hooks.
- Connect agent and code nodes with explicit edges and structured `$ref` bindings.
- Use conditional branches, parallel nodes, joins, retries, timeouts, and guarded cycles.
- Pause before or after any node for human review, then resume from a persisted checkpoint.
- Persist graph events and snapshots as readable JSONL.
- Persist optional direct-agent conversations as JSONL sessions.
- Prune older tool results and summarize old agent context.

Supported model APIs:

- OpenAI Responses
- Anthropic Messages
- OpenAI-compatible Chat Completions

## Requirements

- Node.js 22.19 or newer
- Unit code is trusted and may execute with the permissions of the mini-pie process

## Install

```bash
git clone https://github.com/lkpsg/mini-pie.git
cd mini-pie
npm install --ignore-scripts
npm run build
```

## Project layout

```text
mini-pie.yaml
units/
  researcher/
    unit.yaml
    prompts/
      system.md
  report-graph/
    unit.yaml
    src/
      nodes.ts
    schemas/
```

The top-level file registers models, storage, and unit directories. Prompts, code, and other resources stay with the unit that owns them.

```yaml
version: 2
workspace: .

storage:
  directory: .mini-pie/runs

models:
  main:
    api: openai-responses
    provider: openai
    model: gpt-5
    apiKeyEnv: OPENAI_API_KEY
    reasoning: true

units:
  researcher: ./units/researcher
  report-graph: ./units/report-graph
```

`${ENVIRONMENT_VARIABLE}` placeholders are expanded in top-level and unit YAML files. Models sharing a provider id also share its API-key environment variable.

## Agent units

`units/researcher/unit.yaml`:

```yaml
kind: agent
model: main
systemPrompt:
  file: ./prompts/system.md
userPrompt: "Research this request:\n\n{{input}}"
tools: [read, grep, find, ls, http_request]
thinking: medium
maxTurns: 24
maxToolCalls: 48
```

A configured `subagents` list gives the parent a `delegate` tool. Subagents share the workspace but not conversation history, and nested delegation is disabled.

## Agent hooks

Hooks are shorthand for visible code nodes around the agent node. They use the same persistence, retry, timeout, state, and review behavior as code nodes in a graph.

```yaml
kind: agent
model: main
systemPrompt: You are a precise analyst.
hooks:
  before:
    - id: parse_input
      entry: ./src/hooks.ts#parseInput
      params:
        strict: true
  after:
    - id: normalize_output
      entry: ./src/hooks.ts#normalizeOutput
      review:
        after: true
```

When no hook `input` is configured, the first hook receives the unit input and each later hook receives the preceding output. The agent receives the last `before` output, and the first `after` hook receives the agent output.

## Code nodes

Code entries use `./file.ts#exportName` and resolve relative to the unit directory. Node.js 22 runs erasable TypeScript directly.

```ts
import { defineCodeNode, Type } from "mini-pie";

export const parseInput = defineCodeNode({
  input: Type.Object({ raw: Type.String() }),
  output: Type.Object({ value: Type.String() }),
  params: Type.Object({ strict: Type.Boolean() }),
  async run({ input, params, state, signal, runtime }) {
    if (signal.aborted) throw new Error("Operation aborted");
    const value = params.strict ? input.raw.trim() : input.raw;
    return {
      output: { value },
      statePatch: { parsedBy: runtime.node },
    };
  },
});
```

Inputs, params, and outputs are checked against their TypeBox schemas. A code node must return `{ output, statePatch? }`. `statePatch` is merged into graph state after the node succeeds and any `after` review is approved.

Code modules are trusted application code. mini-pie does not sandbox them.

## Graph units

```yaml
kind: graph
entry: parse
maxSteps: 64
maxVisits: 4
maxConcurrency: 4

nodes:
  parse:
    type: code
    entry: ./src/nodes.ts#parse
    input:
      raw:
        $ref: input

  analyze:
    type: agent
    unit: researcher
    input:
      $ref: results.parse.output.value
    retry: 1
    timeoutMs: 120000

  decide:
    type: code
    entry: ./src/nodes.ts#decide
    input:
      $ref: results.analyze.output
    review:
      after: true
      message: Check the decision before continuing.

edges:
  - from: parse
    to: analyze
  - from: analyze
    to: decide
  - from: decide
    to: analyze
    when:
      path: results.decide.output.status
      equals: retry

output:
  $ref: results.decide.output
```

An agent node references an agent unit and executes its Pi agent definition. A code node executes a registered TypeScript entry. An agent unit's hooks apply when that agent unit is run as an entry unit; graph authors place explicit code nodes around agent nodes when composing a larger graph.

### Data model

Every binding and condition can read four namespaces:

- `input`: immutable graph input
- `state`: mutable values produced by `statePatch`
- `results.<node>`: latest result for each node
- `runtime`: run id, unit, status, step count, and visit counts

A record containing only `$ref` is replaced with the referenced value. Arrays and objects are resolved recursively, so nodes exchange structured data without converting everything to prompt strings.

### Scheduling

- Nodes with no incoming edge are entries when `entry` is omitted.
- Ready nodes run concurrently up to `maxConcurrency`.
- Nodes sharing a `concurrencyKey` never run in the same batch.
- `join: all` waits for every incoming source; `join: any` accepts the first activation.
- `edgeMode: all` activates every matching outgoing edge; `edgeMode: first` activates only the first match.
- Edge conditions support `path`, `exists`, `equals`, and `notEquals`.
- Cycles are allowed and guarded by `maxSteps` and per-node `maxVisits`.
- `retry` is the number of automatic retries after the first attempt.

## Human review and resume

Any node may pause before execution, after execution, or both:

```yaml
review:
  before: true
  after: true
  message: Inspect inputs and output.
```

Without a `ReviewHandler`, `runUnit()` returns `status: "waiting_review"` with a checkpoint request. The complete snapshot is already persisted and can be resumed in another process.

```ts
const paused = await runtime.runUnit("report-graph", input);

if (paused.status === "waiting_review") {
  const completed = await runtime.resume(paused.runId, {
    action: "edit",
    value: { approved: true },
  });
}
```

Review actions:

| Action | Behavior |
| --- | --- |
| `approve` | Continue or accept the staged output |
| `retry` | Execute the node again |
| `edit` | Replace the input before execution or output after execution |
| `skip` | Complete the node as skipped with an optional value |
| `override` | Complete the node without execution using the supplied value |
| `takeover` | Record a human-produced value and complete the node |
| `abort` | Abort the graph run |

Applications can provide a `ReviewHandler` to answer review requests immediately:

```ts
const runtime = await createRuntime(config, {
  baseDir,
  reviewHandler: {
    async review(request) {
      console.error(`Review ${request.node} (${request.phase})`);
      return { action: "approve" };
    },
  },
});
```

## TypeScript API

Load config and run any registered unit:

```ts
import { createRuntime, loadConfig } from "mini-pie";

const loaded = await loadConfig("mini-pie.yaml");
const runtime = await createRuntime(loaded.config, { baseDir: loaded.baseDir });
const result = await runtime.runUnit("report-graph", { topic: "Pi" });

console.log(result.status, result.output, result.runId);
```

`runWorkflow()` is an alias for `runUnit()`.

For the smallest standalone agent without unit files, use `defineAgent()`:

```ts
import { defineAgent } from "mini-pie";

const agent = await defineAgent({
  model: {
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5",
    apiKeyEnv: "OPENAI_API_KEY",
  },
  systemPrompt: "You are a precise coding agent.",
  userPrompt: "Complete this task:\n\n{{input}}",
  tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
  workspace: process.cwd(),
});

try {
  const result = await agent.run("Find and fix the bug.");
  console.log(result.text);
} finally {
  await agent.close();
}
```

`MiniPieAgent.stream()` emits text and tool lifecycle events. `MiniPieRuntime.createAgent()` exposes the same direct-agent API for a configured agent unit; graph hooks are intentionally handled by `runUnit()`.

## CLI

```bash
mini-pie units --config mini-pie.yaml
mini-pie run report-graph "Research graph engineering" --config mini-pie.yaml
mini-pie resume <run-id> approve --config mini-pie.yaml

# Direct streaming agent execution and conversation sessions
mini-pie agent researcher "Inspect the parser" --config mini-pie.yaml
mini-pie agent researcher "Continue" --session my-session --config mini-pie.yaml
```

Use `--json` for machine-readable output. `--session new` generates a direct-agent session id. Graph state always has a run id and persisted JSONL log.

## Built-in tools

| Tool | Purpose |
| --- | --- |
| `read` | Read text and supported images with truncation |
| `write` | Create or overwrite a file |
| `edit` | Apply exact text replacements |
| `bash` | Execute a shell command |
| `grep` | Search text files with a regular expression |
| `find` | Find files by glob |
| `ls` | List a directory |
| `apply_patch` | Apply a unified diff to one file |
| `http_request` | Make an HTTP request |
| `sleep` | Wait for up to 60 seconds |
| `todo` | Maintain an in-memory agent task list |

Tools are opt-in per agent. Custom tools remain available through `defineTool()` and the runtime `tools` option.

## State and persistence

Graph JSONL files contain lifecycle events followed by full snapshots. Node statuses are `pending`, `running`, `waiting_review`, `succeeded`, `failed`, `skipped`, or `cancelled`. Run statuses are `running`, `waiting_review`, `succeeded`, `failed`, or `aborted`.

Agent state is managed by `@earendil-works/pi-agent-core`. Context compaction first replaces old tool-result bodies, then asks the active model to summarize older turns. Full messages remain in agent state and direct-agent session JSONL; compaction only changes context sent to the model.

## Security model

mini-pie has no OS sandbox.

- File tools reject paths outside the configured workspace, including symlink escapes.
- `bash` runs with the permissions of the current process and can access paths outside the workspace.
- `http_request` can reach arbitrary HTTP and HTTPS endpoints available to the process.
- Code nodes and custom tools are trusted application code.
- Human review is a workflow checkpoint, not a security boundary.

Use a container or another sandbox when running untrusted prompts, code, or repositories.

## Development

```bash
npm run check
npm test
npm run build
```

The complete runnable configuration is in [`examples/mini-pie.yaml`](./examples/mini-pie.yaml).

## License and attribution

mini-pie is released under the MIT License. It depends on the MIT-licensed Pi packages `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai`. See [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) for upstream attribution and license text.
