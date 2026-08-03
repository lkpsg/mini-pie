# mini-pie configuration reference

Use this reference while implementing YAML or runtime integration. Verify it against the installed package whenever the target is not the mini-pie source repository.

## Top-level configuration

```yaml
version: 2
workspace: .

storage:
  directory: .mini-pie/runs

models:
  main:
    api: openai-responses
    provider: openai
    model: ${OPENAI_MODEL}
    baseUrl: ${OPENAI_BASE_URL}
    apiKeyEnv: OPENAI_API_KEY
    reasoning: true

units:
  writer: ./units/writer
  report: ./units/report
```

Supported model APIs are `openai-responses`, `anthropic-messages`, and `openai-completions`. Model definitions may also set `headers`, `input`, `contextWindow`, and `maxTokens`.

## Agent unit

```yaml
kind: agent
description: Draft a report from normalized research
model: main
systemPrompt:
  file: ./prompts/system.md
userPrompt: "Create the report from this input:\n\n{{input}}"
tools: [read, grep, find, ls]
thinking: medium
maxTurns: 12
maxToolCalls: 24
```

Optional fields include `subagents`, `compaction`, `hooks`, and `review`.

Built-in tools are `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`, `http_request`, `sleep`, and `todo`.

## Agent hooks

```yaml
hooks:
  before:
    - id: normalize
      entry: ./src/hooks.ts#normalize
      params:
        strict: true
  after:
    - id: validate
      entry: ./src/hooks.ts#validate
      review:
        after: true
        message: Accept the validated result?
```

Each hook may set `input`, `params`, `retry`, `timeoutMs`, and `review`. Hook IDs must be unique; `agent` is reserved.

## Code node

```ts
import { defineCodeNode, Type } from "mini-pie";

export const normalize = defineCodeNode({
  input: Type.Object({ raw: Type.String() }),
  params: Type.Object({ strict: Type.Boolean() }),
  output: Type.Object({ text: Type.String() }),
  async run({ input, params, signal, runtime }) {
    if (signal.aborted) throw new Error("Operation aborted");
    const text = params.strict ? input.raw.trim() : input.raw;
    return {
      output: { text },
      statePatch: { normalizedBy: runtime.node },
    };
  },
});
```

Use entries in the form `./src/nodes.ts#exportName`, resolved from the owning unit directory.

## Graph unit

```yaml
kind: graph
description: Normalize, draft, review, and package a report
entry: normalize
maxSteps: 32
maxVisits: 4
maxConcurrency: 4

nodes:
  normalize:
    type: code
    entry: ./src/nodes.ts#normalize
    input:
      raw:
        $ref: input
    params:
      strict: true

  draft:
    type: agent
    unit: writer
    input:
      $ref: results.normalize.output.text
    retry: 1
    timeoutMs: 120000
    review:
      after: true
      message: Review the draft before packaging it.

  package:
    type: code
    entry: ./src/nodes.ts#packageResult
    input:
      draft:
        $ref: results.draft.output
      normalizedBy:
        $ref: state.normalizedBy

edges:
  - from: normalize
    to: draft
  - from: draft
    to: package

output:
  $ref: results.package.output
```

### Bindings

Bindings recursively resolve arrays and objects. An object whose only key is `$ref` resolves to the referenced value.

- `input`: immutable run input
- `state`: mutable graph state merged from successful `statePatch` values
- `results.<node>.output`: latest output from a node
- `runtime`: run ID, unit, status, step, and visit counts

### Conditions

```yaml
when:
  path: results.route.output.kind
  equals: approved
```

Conditions support `exists`, `equals`, and `notEquals` against scalar values.

### Node controls

- `retry`: retries after the first attempt
- `timeoutMs`: per-attempt timeout
- `concurrencyKey`: prevents matching nodes from sharing a batch
- `join`: `all` or `any`
- `edgeMode`: `all` or `first`
- `review.before` / `review.after`: persisted checkpoint phases

## Runtime API

```ts
import { createRuntime, loadConfig } from "mini-pie";

const loaded = await loadConfig("mini-pie.yaml");
const runtime = await createRuntime(loaded.config, { baseDir: loaded.baseDir });
const result = await runtime.runUnit("report", { topic: "Graph engineering" });

if (result.status === "waiting_review") {
  await runtime.resume(result.runId, { action: "approve" });
}
```

`runWorkflow()` aliases `runUnit()`. Review actions are `approve`, `retry`, `edit`, `skip`, `override`, `takeover`, and `abort`.

## CLI

```bash
mini-pie units --config mini-pie.yaml
mini-pie agents --config mini-pie.yaml
mini-pie workflows --config mini-pie.yaml
mini-pie agent <agent-unit> "<prompt>" --config mini-pie.yaml
mini-pie run <unit> "<input>" --config mini-pie.yaml
mini-pie resume <run-id> approve --config mini-pie.yaml
```

Use `--json` for machine-readable output. Use `--session new` or `--session <id>` only for direct agent sessions.
