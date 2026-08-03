# mini-pie design patterns

Use these patterns to translate conversational product descriptions into visible agent and graph architecture.

## Single semantic task

User language: “Give it a document and have it write a concise executive summary.”

```text
input -> summarize(agent) -> output
```

Use one agent unit when all meaningful work is model-driven and no deterministic boundary is required.

## Agent with deterministic boundaries

User language: “Clean the input first, ask the model to summarize it, then guarantee a typed result.”

```text
input -> normalize(before hook) -> summarize(agent) -> validate(after hook) -> output
```

Use hooks when preprocessing and postprocessing belong to the standalone agent. Use explicit code nodes instead when composing that agent into a larger graph.

## Linear workflow

User language: “Research a topic, write a report, and package it as our result object.”

```text
input -> prepare(code) -> research(agent) -> write(agent) -> package(code) -> output
```

Give each model call one semantic responsibility. Exchange structured data through bindings rather than asking agents to rediscover prior state.

## Parallel fan-out and join

User language: “Have one agent assess technical risk and another assess user impact at the same time, then combine both.”

```text
                    -> technical-risk(agent) -\
input -> prepare(code)                        -> synthesize(agent) -> output
                    -> user-impact(agent) ----/
```

Connect both branches to the synthesis node and set `join: all`. Set a finite `maxConcurrency`. Use distinct agent units if the roles require different prompts or tools.

## Conditional routing

User language: “Classify the request. Bugs go to the debugger; feature ideas go to the planner.”

```text
input -> classify(code or agent) -> debugger(agent) -\
                               \-> planner(agent) ----> output
```

Produce a scalar route such as `bug` or `feature`. Put one condition on each outgoing edge and set `edgeMode: first` when exactly one route must run. Add an explicit fallback route when classification can be unknown.

## Human approval

User language: “Draft the message, but do not send or finalize it until I approve it.”

```text
input -> draft(agent) -> review(after checkpoint) -> finalize(code) -> output
```

Place `review.after` on the draft when the reviewer should inspect or edit generated output. Place `review.before` on a consequential node when approval must happen before execution. Keep the actual external side effect in a separate code node after approval.

## Bounded feedback loop

User language: “Review the draft and let the writer revise it up to three times.”

```text
input -> write(agent) -> assess(code or agent) -> accepted -> output
                         |           ^
                         \-> revise -/
```

Return a scalar decision and route the retry edge conditionally. Set both `maxSteps` and `maxVisits`. Preserve the latest draft and feedback in explicit results or state. Do not use an unbounded self-loop.

## Parent agent with subagents

User language: “Let the coordinator decide when to ask the researcher or reviewer for help.”

```text
input -> coordinator(agent with delegate tool) -> output
                |-> researcher(subagent)
                \-> reviewer(subagent)
```

Use `subagents` when delegation itself is model-driven and the exact call sequence does not need to be visible in a graph. Use graph nodes when ordering, parallelism, data contracts, checkpoints, or retries must be explicit. Subagents share the workspace but not the parent conversation history, and nested delegation is disabled.

## Integration side effect

User language: “Generate the payload, ask for approval, then call our service.”

```text
input -> generate(agent) -> validate(code) -> approve(review) -> call-service(code) -> output
```

Keep the service call in trusted TypeScript. Validate the payload before review, place approval immediately before the side-effecting node, set a timeout, and only configure retries if the service operation is idempotent.
