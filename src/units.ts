import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseUnitText } from "./config.ts";
import type {
	AgentUnitDefinition,
	BindingValue,
	CodeGraphNodeDefinition,
	CodeHookDefinition,
	GraphEdgeDefinition,
	GraphNodeDefinition,
	GraphUnitDefinition,
	LoadedUnit,
	MiniPieConfig,
	UnitDefinition,
} from "./types.ts";

function reference(path: string): BindingValue {
	return { $ref: path };
}

function registrationPath(registration: string | { path: string }): string {
	return typeof registration === "string" ? registration : registration.path;
}

async function loadUnit(name: string, registration: string | { path: string }, baseDir: string, config: MiniPieConfig) {
	const target = resolve(baseDir, registrationPath(registration));
	const targetStat = await stat(target);
	const filePath = targetStat.isDirectory() ? resolve(target, "unit.yaml") : target;
	const directory = targetStat.isDirectory() ? target : dirname(target);
	const definition = parseUnitText(await readFile(filePath, "utf8"), config.models, process.env, `units.${name}`);
	return { name, directory, filePath, definition } satisfies LoadedUnit;
}

function validateReferences(units: ReadonlyMap<string, LoadedUnit>): void {
	for (const unit of units.values()) {
		if (unit.definition.kind === "agent") {
			for (const subagent of unit.definition.subagents ?? []) {
				const target = units.get(subagent);
				if (!target) throw new Error(`Agent unit "${unit.name}" references unknown subagent "${subagent}"`);
				if (target.definition.kind !== "agent") {
					throw new Error(`Subagent "${subagent}" referenced by "${unit.name}" is not an agent unit`);
				}
			}
			continue;
		}
		for (const [nodeId, node] of Object.entries(unit.definition.nodes)) {
			if (node.type !== "agent") continue;
			const target = units.get(node.unit);
			if (!target) throw new Error(`Graph unit "${unit.name}" node "${nodeId}" references unknown unit "${node.unit}"`);
			if (target.definition.kind !== "agent") {
				throw new Error(`Graph unit "${unit.name}" node "${nodeId}" must reference an agent unit`);
			}
		}
	}
}

export class UnitRegistry {
	private readonly byName: ReadonlyMap<string, LoadedUnit>;

	private constructor(units: ReadonlyMap<string, LoadedUnit>) {
		this.byName = units;
	}

	static async load(config: MiniPieConfig, baseDir: string): Promise<UnitRegistry> {
		const entries = await Promise.all(
			Object.entries(config.units).map(
				async ([name, registration]) => [name, await loadUnit(name, registration, baseDir, config)] as const,
			),
		);
		const units = new Map(entries);
		validateReferences(units);
		return new UnitRegistry(units);
	}

	get(name: string): LoadedUnit {
		const unit = this.byName.get(name);
		if (!unit) throw new Error(`Unknown unit: ${name}`);
		return unit;
	}

	list(kind?: UnitDefinition["kind"]): LoadedUnit[] {
		return Array.from(this.byName.values()).filter((unit) => kind === undefined || unit.definition.kind === kind);
	}
}

function hookNode(hook: CodeHookDefinition, input: BindingValue) {
	return {
		type: "code",
		entry: hook.entry,
		input: hook.input ?? input,
		...(hook.params !== undefined ? { params: hook.params } : {}),
		...(hook.retry !== undefined ? { retry: hook.retry } : {}),
		...(hook.timeoutMs !== undefined ? { timeoutMs: hook.timeoutMs } : {}),
		...(hook.review ? { review: hook.review } : {}),
	} satisfies CodeGraphNodeDefinition;
}

export function compileAgentUnit(unit: LoadedUnit & { definition: AgentUnitDefinition }): GraphUnitDefinition {
	const nodes: Record<string, GraphNodeDefinition> = {};
	const edges: GraphEdgeDefinition[] = [];
	let previousNode: string | undefined;
	let previousValue: BindingValue = reference("input");

	for (const hook of unit.definition.hooks?.before ?? []) {
		const nodeId = `before_${hook.id}`;
		nodes[nodeId] = hookNode(hook, previousValue);
		if (previousNode) edges.push({ from: previousNode, to: nodeId });
		previousNode = nodeId;
		previousValue = reference(`results.${nodeId}.output`);
	}

	nodes.agent = {
		type: "agent",
		unit: unit.name,
		input: previousValue,
		...(unit.definition.review ? { review: unit.definition.review } : {}),
	};
	if (previousNode) edges.push({ from: previousNode, to: "agent" });
	previousNode = "agent";
	previousValue = reference("results.agent.output");

	for (const hook of unit.definition.hooks?.after ?? []) {
		const nodeId = `after_${hook.id}`;
		nodes[nodeId] = hookNode(hook, previousValue);
		edges.push({ from: previousNode, to: nodeId });
		previousNode = nodeId;
		previousValue = reference(`results.${nodeId}.output`);
	}

	return {
		kind: "graph",
		entry: unit.definition.hooks?.before?.[0] ? `before_${unit.definition.hooks.before[0].id}` : "agent",
		nodes,
		edges,
		output: previousValue,
		maxConcurrency: 1,
	};
}

export function graphForUnit(unit: LoadedUnit): GraphUnitDefinition {
	return unit.definition.kind === "graph"
		? unit.definition
		: compileAgentUnit(unit as LoadedUnit & { definition: AgentUnitDefinition });
}
