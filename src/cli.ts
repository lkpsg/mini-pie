#!/usr/bin/env node
import { AgentRunError } from "./agent.ts";
import { type LoadedConfig, loadConfig } from "./config.ts";
import { createRuntime } from "./runtime.ts";
import { createSessionId } from "./session.ts";
import type { MiniPieEvent, RunResult } from "./types.ts";

const VERSION = "0.1.0";

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
  mini-pie run <agent> <prompt...> [--session <id|new>] [--json] [--verbose]
  mini-pie workflow <workflow> <input...> [--json]
  mini-pie agents
  mini-pie workflows

Options:
  --config <path>   YAML configuration file (default: mini-pie.yaml)
  --session <id>    Load or create a JSONL session; use "new" to generate an id
  --json            Emit JSON Lines
  --verbose         Print tool activity to stderr
  --help             Show this help
  --version          Show the version`;
}

function logToolEvent(event: MiniPieEvent): void {
	if (event.type === "tool_start") process.stderr.write(`[tool:start] ${event.name}\n`);
	else if (event.type === "tool_end") {
		process.stderr.write(`[tool:${event.isError ? "error" : "end"}] ${event.name}\n`);
	}
}

async function runAgentCommand(
	options: CliArguments,
	loaded: LoadedConfig,
	agentName: string,
	prompt: string,
): Promise<void> {
	const runtime = await createRuntime(loaded.config, { baseDir: loaded.baseDir });
	const sessionId = options.sessionId === "new" ? createSessionId() : options.sessionId;
	const agent = await runtime.createAgent(agentName, { ...(sessionId ? { sessionId } : {}) });
	if (options.sessionId === "new" && !options.json) process.stderr.write(`Session: ${sessionId}\n`);
	let finalResult: RunResult | undefined;
	let wroteText = false;
	const onSigint = () => agent.abort();
	process.once("SIGINT", onSigint);
	try {
		for await (const event of agent.stream(prompt)) {
			if (options.json) {
				process.stdout.write(`${JSON.stringify(event)}\n`);
			} else if (event.type === "text_delta") {
				process.stdout.write(event.delta);
				wroteText = true;
			} else if (options.verbose) {
				logToolEvent(event);
			}
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
	if (options.command === "agents") {
		process.stdout.write(`${Object.keys(loaded.config.agents).join("\n")}\n`);
		return;
	}
	if (options.command === "workflows") {
		process.stdout.write(`${Object.keys(loaded.config.workflows ?? {}).join("\n")}\n`);
		return;
	}
	if (options.command === "run") {
		const [agentName, ...promptParts] = options.positionals;
		if (!agentName || promptParts.length === 0) throw new Error("run requires an agent name and prompt");
		await runAgentCommand(options, loaded, agentName, promptParts.join(" "));
		return;
	}
	if (options.command === "workflow") {
		const [workflowName, ...inputParts] = options.positionals;
		if (!workflowName || inputParts.length === 0) throw new Error("workflow requires a workflow name and input");
		const runtime = await createRuntime(loaded.config, { baseDir: loaded.baseDir });
		const result = await runtime.runWorkflow(workflowName, inputParts.join(" "));
		process.stdout.write(options.json ? `${JSON.stringify(result)}\n` : `${result.output}\n`);
		return;
	}
	throw new Error(`Unknown command: ${options.command}`);
}

main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
