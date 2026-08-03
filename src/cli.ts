#!/usr/bin/env node
import { AgentRunError } from "./agent.ts";
import { type LoadedConfig, loadConfig } from "./config.ts";
import { createRuntime, type MiniPieRuntime } from "./runtime.ts";
import { createSessionId } from "./session.ts";
import type { GraphRunResult, MiniPieEvent, ReviewAction, ReviewDecision, RunResult } from "./types.ts";

const VERSION = "0.2.0";
const REVIEW_ACTIONS: readonly ReviewAction[] = ["approve", "retry", "edit", "skip", "abort", "override", "takeover"];

interface CliArguments {
	command?: string;
	positionals: string[];
	configPath: string;
	sessionId?: string;
	json: boolean;
	verbose: boolean;
	help: boolean;
}

function requireFlagValue(args: string[], index: number, flag: string): string {
	const value = args[index + 1];
	if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
	return value;
}

function parseArguments(args: string[]): CliArguments {
	const positionals: string[] = [];
	let configPath = "mini-pie.yaml";
	let sessionId: string | undefined;
	let json = false;
	let verbose = false;
	let help = false;
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if (argument === undefined) continue;
		if (argument === "--config") {
			configPath = requireFlagValue(args, index, argument);
			index++;
		} else if (argument === "--session") {
			sessionId = requireFlagValue(args, index, argument);
			index++;
		} else if (argument === "--json") {
			json = true;
		} else if (argument === "--verbose") {
			verbose = true;
		} else if (argument === "--help" || argument === "-h") {
			help = true;
		} else if (argument === "--version" || argument === "-v") {
			positionals.push("version");
		} else if (argument.startsWith("--")) {
			throw new Error(`Unknown option: ${argument}`);
		} else {
			positionals.push(argument);
		}
	}
	return {
		...(positionals[0] ? { command: positionals[0] } : {}),
		positionals: positionals.slice(1),
		configPath,
		...(sessionId ? { sessionId } : {}),
		json,
		verbose,
		help,
	};
}

function usage(): string {
	return `mini-pie ${VERSION}

Usage:
  mini-pie run <unit> <input...> [--json]
  mini-pie agent <agent-unit> <prompt...> [--session <id|new>] [--json] [--verbose]
  mini-pie resume <run-id> <action> [value] [--json]
  mini-pie units
  mini-pie agents
  mini-pie workflows

Review actions:
  approve, retry, edit, skip, abort, override, takeover

Options:
  --config <path>   YAML configuration file (default: mini-pie.yaml)
  --session <id>    Agent JSONL session; use "new" to generate an id
  --json            Emit JSON
  --verbose         Print agent tool activity to stderr
  --help            Show this help
  --version         Show the version`;
}

function logToolEvent(event: MiniPieEvent): void {
	if (event.type === "tool_start") process.stderr.write(`[tool:start] ${event.name}\n`);
	else if (event.type === "tool_end") {
		process.stderr.write(`[tool:${event.isError ? "error" : "end"}] ${event.name}\n`);
	}
}

function displayGraphResult(result: GraphRunResult, json: boolean): void {
	if (json) {
		process.stdout.write(`${JSON.stringify(result)}\n`);
		return;
	}
	if (result.status === "waiting_review" && result.review) {
		process.stdout.write(
			`Run ${result.runId} is waiting for ${result.review.phase} review at node ${result.review.node}.\n` +
				`Resume with: mini-pie resume ${result.runId} approve\n`,
		);
		return;
	}
	if (result.status === "failed" || result.status === "aborted") {
		throw new Error(result.error ?? `Graph run ${result.status}`);
	}
	process.stdout.write(
		`${typeof result.output === "string" ? result.output : JSON.stringify(result.output, null, 2)}\n`,
	);
}

function parseDecision(actionValue: string, valueParts: string[]): ReviewDecision {
	if (!REVIEW_ACTIONS.includes(actionValue as ReviewAction)) throw new Error(`Unknown review action: ${actionValue}`);
	if (valueParts.length === 0) return { action: actionValue as ReviewAction };
	const source = valueParts.join(" ");
	let value: unknown;
	try {
		value = JSON.parse(source) as unknown;
	} catch {
		value = source;
	}
	return { action: actionValue as ReviewAction, value };
}

async function runAgentCommand(
	options: CliArguments,
	runtime: MiniPieRuntime,
	agentName: string,
	prompt: string,
): Promise<void> {
	const sessionId = options.sessionId === "new" ? createSessionId() : options.sessionId;
	const agent = await runtime.createAgent(agentName, { ...(sessionId ? { sessionId } : {}) });
	if (options.sessionId === "new" && !options.json) process.stderr.write(`Session: ${sessionId}\n`);
	let finalResult: RunResult | undefined;
	let wroteText = false;
	const onSigint = () => agent.abort();
	process.once("SIGINT", onSigint);
	try {
		for await (const event of agent.stream(prompt)) {
			if (options.json) process.stdout.write(`${JSON.stringify(event)}\n`);
			else if (event.type === "text_delta") {
				process.stdout.write(event.delta);
				wroteText = true;
			} else if (options.verbose) logToolEvent(event);
			if (event.type === "end") finalResult = event.result;
		}
		if (!options.json && wroteText) process.stdout.write("\n");
		if (!finalResult) throw new Error("Agent completed without a result");
		if (finalResult.message.stopReason === "error" || finalResult.message.stopReason === "aborted") {
			throw new AgentRunError(finalResult);
		}
	} finally {
		process.removeListener("SIGINT", onSigint);
		await agent.close();
	}
}

async function createConfiguredRuntime(loaded: LoadedConfig): Promise<MiniPieRuntime> {
	return createRuntime(loaded.config, { baseDir: loaded.baseDir });
}

async function main(): Promise<void> {
	const options = parseArguments(process.argv.slice(2));
	if (options.help || !options.command) {
		process.stdout.write(`${usage()}\n`);
		return;
	}
	if (options.command === "version") {
		process.stdout.write(`${VERSION}\n`);
		return;
	}
	const loaded = await loadConfig(options.configPath);
	const runtime = await createConfiguredRuntime(loaded);
	if (options.command === "units" || options.command === "agents" || options.command === "workflows") {
		const kind = options.command === "agents" ? "agent" : options.command === "workflows" ? "graph" : undefined;
		process.stdout.write(
			`${runtime
				.listUnits(kind)
				.map((unit) => unit.name)
				.join("\n")}\n`,
		);
		return;
	}
	if (options.command === "agent") {
		const [agentName, ...promptParts] = options.positionals;
		if (!agentName || promptParts.length === 0) throw new Error("agent requires an agent unit name and prompt");
		await runAgentCommand(options, runtime, agentName, promptParts.join(" "));
		return;
	}
	if (options.command === "run" || options.command === "workflow") {
		const [unitName, ...inputParts] = options.positionals;
		if (!unitName || inputParts.length === 0) throw new Error(`${options.command} requires a unit name and input`);
		displayGraphResult(await runtime.runUnit(unitName, inputParts.join(" ")), options.json);
		return;
	}
	if (options.command === "resume") {
		const [runId, action, ...valueParts] = options.positionals;
		if (!runId || !action) throw new Error("resume requires a run id and review action");
		displayGraphResult(await runtime.resume(runId, parseDecision(action, valueParts)), options.json);
		return;
	}
	throw new Error(`Unknown command: ${options.command}`);
}

main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
