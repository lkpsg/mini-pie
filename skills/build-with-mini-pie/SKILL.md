---
name: build-with-mini-pie
description: Translate conversational, spoken, or rough natural-language requirements into working mini-pie agent units, agent hooks, graph workflows, and TypeScript code nodes. Use when a user asks to create, extend, configure, debug, or explain a mini-pie agent/workflow/graph; says things such as "build this with mini-pie", "用 mini-pie 做一个 agent", "把这个流程编排成 graph", or describes an agent application without knowing mini-pie terminology.
---

# Build with mini-pie

Translate the user's description into a small, inspectable mini-pie implementation. Accept product language and incomplete terminology; map it to agent units, deterministic code nodes, edges, bindings, checkpoints, and runtime calls.

## Ground the work

1. Locate the target project and its nearest `mini-pie.yaml` and `package.json`.
2. Read repository instructions before editing.
3. Determine the installed mini-pie version. In a downstream project, inspect `node_modules/mini-pie/package.json` and exported types instead of assuming the current API.
4. When working in the mini-pie source repository, use `README.md` or `README.zh-CN.md`, `src/types.ts`, `src/config.ts`, and `examples/` as the source of truth.
5. Treat [configuration-reference.md](references/configuration-reference.md) as a concise guide. Let the target project's installed types and documentation win if they differ.

## Interpret conversational requirements

- Reply in the user's language.
- Recover the intended outcome, input, output, and control flow from ordinary speech. Do not require the user to name framework concepts.
- Make low-risk defaults and state them briefly. Ask only when a missing choice materially changes behavior, security, cost, or external side effects.
- Separate semantic work from deterministic work. Put interpretation, planning, classification of ambiguous content, and generation in agents. Put parsing, schema validation, calculations, integrations, and explicit business rules in code nodes.
- Summarize the proposed topology in one compact line before implementing, for example: `input -> normalize(code) -> research(agent) -> approve(review) -> package(code)`.
- If the user asks to build or change something, edit the project and validate it. Do not stop at a conceptual YAML example.

## Choose the smallest shape

| Requirement | Implement as |
| --- | --- |
| One model-driven task | Agent unit |
| Deterministic preprocessing or output validation around one agent | Agent unit with before/after hooks |
| Multiple stages, agents, branches, joins, retries, loops, or review points | Graph unit |
| A small programmatic one-off agent with no reusable unit files | `defineAgent()` |
| A parent agent that may assign independent semantic tasks | Agent `subagents` |
| Explicit approval, editing, retry, or takeover | Node `review` checkpoint |

Treat “workflow” as the user's application-level name for a graph. mini-pie uses the graph runtime for workflows, and `runWorkflow()` aliases `runUnit()`.

Read [design-patterns.md](references/design-patterns.md) when the request includes branching, parallel work, loops, human review, or several cooperating agents.

## Design before editing

Capture only the decisions needed to implement:

- Input and final output contract
- Agent responsibilities, prompts, model, tools, and turn/tool-call limits
- Code-node responsibilities and TypeBox schemas
- Edges for control flow and `$ref` bindings for data flow
- State that must survive between nodes
- Retry, timeout, concurrency, and loop bounds
- Review points and allowed continuation behavior
- Persistence and resume entry points

Prefer a self-contained `units/<name>/` directory. Keep its `unit.yaml`, prompts, TypeScript code, schemas, and local resources together. Register units and models in the top-level `mini-pie.yaml`.

## Implement agents

1. Put stable instructions in a system-prompt file when they are more than a short sentence.
2. Use `{{input}}` in the user-prompt template to expose the runtime input.
3. Enable only the tools the agent needs.
4. Set finite `maxTurns` and `maxToolCalls` for tool-using agents.
5. Use `subagents` only when tasks are genuinely independent; nested delegation is unavailable.
6. Keep deterministic acceptance criteria out of prompts when code can enforce them.

## Implement code nodes and hooks

1. Export code nodes with `defineCodeNode()` and TypeBox `Type` schemas from `mini-pie`.
2. Validate `input`, `params`, and `output` with explicit schemas. Use `Type.Unknown()` only at an intentional external boundary.
3. Return `{ output, statePatch? }` and keep `statePatch` limited to values needed by later nodes or inspection.
4. Honor `signal.aborted` before expensive or side-effecting work.
5. Use erasable TypeScript compatible with Node.js strip-only execution.
6. Keep non-trivial computation in TypeScript. Do not invent expressions inside YAML.
7. Use hooks only for behavior owned by one standalone agent. In a larger graph, add explicit code nodes and review settings around the referenced Agent Node because the referenced Agent Unit's hooks and Unit-level review do not run when it is embedded as a Graph Node.

## Implement graphs

1. Use edges for activation and `$ref` objects for values. Bind only from `input`, `state`, `results.<node>`, or `runtime`.
2. Make branch conditions read a scalar path produced by a node. Put compound decisions in a code node.
3. Set `join: all` when a node requires every incoming result; use `join: any` only when the first activation is sufficient.
4. Set `edgeMode: first` for mutually exclusive ordered routes and leave the default all-match behavior for fan-out.
5. Bound cycles with `maxSteps` and `maxVisits`.
6. Add `retry` only for operations that are safe to repeat. Add `timeoutMs` to model or integration nodes that can stall.
7. Use `concurrencyKey` for nodes that must not run in the same batch.
8. Place `review.before` before consequential execution and `review.after` before accepting uncertain output. Remember that review is a checkpoint, not a security sandbox.
9. Define an explicit graph `output` rather than relying on the last completed node when the graph branches.

## Handle configuration and secrets

- Use `version: 2`.
- Put model URLs, keys, and model names behind environment variables where appropriate.
- Commit an empty `.env.example`, never a populated `.env` or secret.
- Configure `workspace` narrowly. File tools stay inside it, but `bash`, HTTP calls, code nodes, and custom tools still run with the process's authority.
- Do not add an OS sandbox claim. Recommend an external container or sandbox for untrusted work.

## Validate

Run the narrowest checks that establish correctness:

1. Load and list the configuration with the project-local CLI, such as `mini-pie units --config mini-pie.yaml`.
2. Run the project's typecheck or check command after TypeScript changes.
3. Add focused tests for code nodes, bindings, branch conditions, review behavior, and resume behavior. Avoid live model calls in unit tests.
4. Run code-only paths without provider credentials when possible.
5. Run a real agent or graph smoke test only when credentials are available and the user has authorized the model/API use.
6. Inspect the resulting status, output, state, node results, and persisted JSONL checkpoint—not only the process exit code.

Follow the target repository's prescribed commands when they are stricter. Do not install dependencies or run lifecycle scripts without checking repository policy.

## Hand off

Report:

- The implemented topology and why it fits the spoken requirement
- Files created or changed
- How to configure environment variables
- Exact commands to list and run the unit
- How to resume any review checkpoint
- Which validations ran and any validation that still requires credentials

Offer the next useful conversational refinement, such as adding a branch, approval point, tool, schema, or test, without requiring the user to learn mini-pie vocabulary first.
