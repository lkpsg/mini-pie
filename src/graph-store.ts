import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { uuidv7 } from "@earendil-works/pi-agent-core";
import type { GraphNodeResult, GraphNodeRuntimeState, GraphRunStatus, ReviewRequest } from "./types.ts";

export interface StagedNodeResult {
	input: unknown;
	result: GraphNodeResult;
}

export interface GraphRunSnapshot {
	version: 1;
	sequence: number;
	runId: string;
	unit: string;
	status: GraphRunStatus;
	input: unknown;
	state: Record<string, unknown>;
	results: Record<string, GraphNodeResult>;
	nodes: Record<string, GraphNodeRuntimeState>;
	ready: string[];
	pendingTriggers: Record<string, string[]>;
	stepCount: number;
	lastOutput?: unknown;
	output?: unknown;
	review?: ReviewRequest;
	reviewQueue: ReviewRequest[];
	staged: Record<string, StagedNodeResult>;
	approvedReviews: string[];
	inputOverrides: Record<string, unknown>;
	error?: string;
	startedAt: string;
	updatedAt: string;
}

export type GraphRunEventType =
	| "run_started"
	| "node_started"
	| "node_succeeded"
	| "node_failed"
	| "node_skipped"
	| "review_requested"
	| "review_decided"
	| "run_succeeded"
	| "run_failed"
	| "run_aborted";

export interface GraphRunEvent {
	type: GraphRunEventType;
	runId: string;
	sequence: number;
	timestamp: string;
	node?: string;
	details?: Record<string, unknown>;
}

interface SnapshotLine {
	type: "snapshot";
	snapshot: GraphRunSnapshot;
}

function validateRunId(runId: string): void {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(runId)) {
		throw new Error("Run id may contain only letters, numbers, dots, underscores, and hyphens");
	}
}

function serialize(value: GraphRunEvent | SnapshotLine): string {
	try {
		return JSON.stringify(value);
	} catch (error) {
		throw new Error("Graph state must contain only JSON-serializable values", { cause: error });
	}
}

function isSnapshot(value: unknown): value is SnapshotLine {
	return (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		value.type === "snapshot" &&
		"snapshot" in value &&
		typeof value.snapshot === "object" &&
		value.snapshot !== null
	);
}

export interface GraphRunStore {
	initialize(snapshot: GraphRunSnapshot, event: GraphRunEvent): Promise<void>;
	record(snapshot: GraphRunSnapshot, event: GraphRunEvent): Promise<void>;
	load(runId: string): Promise<GraphRunSnapshot>;
}

export class JsonlGraphRunStore implements GraphRunStore {
	readonly directory: string;

	constructor(directory: string) {
		this.directory = resolve(directory);
	}

	filePath(runId: string): string {
		validateRunId(runId);
		return resolve(this.directory, `${runId}.jsonl`);
	}

	async initialize(snapshot: GraphRunSnapshot, event: GraphRunEvent): Promise<void> {
		await mkdir(this.directory, { recursive: true });
		const content = `${serialize(event)}\n${serialize({ type: "snapshot", snapshot })}\n`;
		await writeFile(this.filePath(snapshot.runId), content, { encoding: "utf8", flag: "wx" });
	}

	async record(snapshot: GraphRunSnapshot, event: GraphRunEvent): Promise<void> {
		const content = `${serialize(event)}\n${serialize({ type: "snapshot", snapshot })}\n`;
		await appendFile(this.filePath(snapshot.runId), content, "utf8");
	}

	async load(runId: string): Promise<GraphRunSnapshot> {
		const text = await readFile(this.filePath(runId), "utf8");
		let latest: GraphRunSnapshot | undefined;
		for (const [index, line] of text.split("\n").entries()) {
			if (line.trim().length === 0) continue;
			let value: unknown;
			try {
				value = JSON.parse(line) as unknown;
			} catch (error) {
				throw new Error(`Invalid graph run JSON at ${this.filePath(runId)}:${index + 1}`, { cause: error });
			}
			if (isSnapshot(value)) latest = value.snapshot;
		}
		if (!latest) throw new Error(`Graph run has no persisted snapshot: ${runId}`);
		if (latest.version !== 1 || latest.runId !== runId) throw new Error(`Invalid graph run snapshot: ${runId}`);
		return latest;
	}
}

export function createRunId(): string {
	return uuidv7();
}
