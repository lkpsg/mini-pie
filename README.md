# mini-pie

A minimal, headless TypeScript agent framework built on [Pi](https://github.com/earendil-works/pi).

mini-pie keeps Pi's streaming agent loop, state model, provider adapters, and core coding tools, then adds a small configuration and orchestration layer for named agents, isolated subagents, and workflows. It has no UI, server, database, MCP layer, or approval system.

## Features

- Define an agent with a model, system prompt, user prompt template, and tools.
- Use `run()` for a final result or `stream()` for structured events.
- Configure named agents, subagents, and workflows in YAML.
- Register custom tools from TypeScript.
- Persist optional sessions as transparent JSONL files.
- Prune older tool results and summarize old context when the context grows.
- Run sequential, parallel, conditional, and retried workflow steps.

Supported model APIs in the first release:

- OpenAI Responses
- Anthropic Messages
- OpenAI-compatible Chat Completions

## Requirements

- Node.js 22.19 or newer

## Install

```bash
git clone https://github.com/lkpsg/mini-pie.git
cd mini-pie
npm install --ignore-scripts
npm run build
```

## TypeScript API

```ts
import { defineAgent } from "mini-pie";

const agent = await defineAgent({
  model: {
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5",
    apiKeyEnv: "OPENAI_API_KEY",
    reasoning: true,
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

Streaming uses the same agent instance:

```ts
for await (const event of agent.stream("Inspect the repository.")) {
  if (event.type === "text_delta") process.stdout.write(event.delta);
  if (event.type === "tool_start") console.error(`Running ${event.name}`);
}
```

### Custom tools

```ts
import { defineAgent, defineTool, Type } from "mini-pie";

const lookup = defineTool({
  name: "lookup",
  label: "lookup",
  description: "Look up a value by key.",
  parameters: Type.Object({ key: Type.String() }),
  async execute(_id, { key }) {
    return {
      content: [{ type: "text", text: `value:${key}` }],
      details: {},
    };
  },
});

const agent = await defineAgent({
  model: {
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
  },
  systemPrompt: "Use the registered tools when needed.",
  tools: [lookup],
});
```

`defineAgent()` is the shortest entry point. For several agents or workflows, use `defineConfig()` and `createRuntime()` or load YAML.

## YAML configuration

```yaml
version: 1
workspace: .

models:
  main:
    api: openai-responses
    provider: openai
    model: gpt-5
    apiKeyEnv: OPENAI_API_KEY
    reasoning: true
    contextWindow: 400000
    maxTokens: 32000

  compatible:
    api: openai-completions
    provider: local
    model: qwen3-coder
    baseUrl: http://localhost:11434/v1
    apiKeyEnv: LOCAL_API_KEY

agents:
  coder:
    model: main
    systemPrompt:
      file: ./prompts/coder.md
    userPrompt: "Complete this task:\n\n{{input}}"
    tools: [read, write, edit, apply_patch, bash, grep, find, ls, http_request, sleep, todo]
    subagents: [explorer]
    thinking: medium
    maxTurns: 32
    maxToolCalls: 64

  explorer:
    model: compatible
    systemPrompt: Find relevant code and return concise evidence.
    tools: [read, grep, find, ls]

workflows:
  inspect-and-implement:
    steps:
      - id: inspect
        agent: explorer
        prompt: "Inspect the repository for this task: {{input}}"
        retry: 1
      - parallel:
          - id: risks
            agent: explorer
            prompt: "Identify risks: {{steps.inspect.output}}"
          - id: tests
            agent: explorer
            prompt: "Propose tests: {{steps.inspect.output}}"
      - id: implement
        agent: coder
        when:
          path: steps.inspect.output
          notEquals: ""
        prompt: |
          Implement {{input}}.

          Analysis: {{steps.inspect.output}}
          Risks: {{steps.risks.output}}
          Tests: {{steps.tests.output}}
```

Prompt values may be inline strings or `{ file: path }`. `${ENVIRONMENT_VARIABLE}` placeholders are expanded while loading YAML. Models sharing a provider id also share its API-key environment variable.

The full example is in [`examples/mini-pie.yaml`](./examples/mini-pie.yaml).

## CLI

```bash
mini-pie agents --config mini-pie.yaml
mini-pie run coder "Fix the failing parser test" --config mini-pie.yaml
mini-pie run coder "Continue the task" --session my-session --config mini-pie.yaml
mini-pie workflow inspect-and-implement "Add a cache" --config mini-pie.yaml
```

Use `--json` for JSON Lines events and `--verbose` for tool lifecycle messages. `--session new` generates a session id. Without `--session`, execution is in-memory only.

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

Tools are opt-in per agent. A parent with configured `subagents` also receives a `delegate` tool.

## Subagent semantics

- The parent delegates an explicit task through `delegate`.
- The subagent starts with no parent conversation history.
- Parent and subagent share the same workspace.
- Each agent has its own tool list and system prompt.
- At most two subagents run concurrently.
- A subagent cannot delegate again in the first release.

## Workflows

Workflow steps are deterministic orchestration around agents. The first release supports:

- Ordered agent steps
- Parallel step groups
- Safe conditions using `path`, `exists`, `equals`, and `notEquals`
- Per-step retry counts
- `{{input}}` and `{{steps.<id>.output}}` templates

It intentionally does not evaluate JavaScript expressions or implement a general graph engine.

## Context and sessions

Agent state is managed by `@earendil-works/pi-agent-core`.

Context compaction has two stages:

1. Replace old tool-result bodies after the pruning threshold.
2. Ask the active model to summarize older turns after the summarization threshold.

If summarization fails, the pruned context is used. Full messages remain in agent state and JSONL sessions; compaction only changes the context sent to the model.

## Security model

mini-pie has no approval system and no OS sandbox.

- File tools reject paths outside the configured workspace, including symlink escapes.
- `bash` runs with the permissions of the current process and can access paths outside the workspace.
- `http_request` can reach arbitrary HTTP and HTTPS endpoints available to the process.
- Custom tools are trusted application code.

Use a container or another sandbox when running untrusted prompts or repositories.

## Scope

The initial release intentionally excludes UI, MCP, ACP, web services, databases, dynamic plugin loading, nested subagents, and an expression language.

## Development

```bash
npm run check
npm test
```

## License and attribution

mini-pie is released under the MIT License. It depends on the MIT-licensed Pi packages `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai`. See [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) for upstream attribution and license text.
