import { conditionMatches, type GraphBindingContext, resolveBindings } from "./bindings.ts";
import { createRunId, type GraphRunEventType, type GraphRunSnapshot, type GraphRunStore } from "./graph-store.ts";
import type {
	BindingValue,
	CodeNodeRunResult,
	GraphNodeDefinition,
	GraphNodeResult,
	GraphRunResult,
	GraphRuntimeContext,
	GraphUnitDefinition,
	ReviewDecision,
	ReviewRequest,
} from "./types.ts";

const DEFAULT_MAX_STEPS = 128;
const DEFAULT_MAX_VISITS = 8;
const DEFAULT_MAX_CONCURRENCY = 4;

export interface GraphNodeRunner {
	runAgent(unit: string, input: unknown, signal: AbortSignal): Promise<unknown>;
	runCode(options: {
		entry: string;
		unitDirectory: string;
		input: unknown;
		params: unknown;
		state: Readonly<Record<string, unknown>>;
		signal: AbortSignal;
		runtime: Readonly<GraphRuntimeContext>;
	}): Promise<CodeNodeRunResult>;
}

export interface GraphExecutionOptions {
	unit: string;
	definition: GraphUnitDefinition;
	unitDirectory: string;
	store: GraphRunStore;
	runner: GraphNodeRunner;
	signal?: AbortSignal;
}

export interface StartGraphOptions extends GraphExecutionOptions {
	input: unknown;
	initialState?: Record<string, unknown>;
	runId?: string;
}

interface NodeExecution {
	nodeId: string;
	node: GraphNodeDefinition;
	input: unknown;
	params: unknown;
	visit: number;
	startedAt: string;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function runtimeContext(snapshot: GraphRunSnapshot): GraphRuntimeContext {
	return {
		runId: snapshot.runId,
		unit: snapshot.unit,
		status: snapshot.status,
		step: snapshot.stepCount,
		visits: Object.fromEntries(Object.entries(snapshot.nodes).map(([id, node]) => [id, node.visits])),
	};
}

function bindingContext(snapshot: GraphRunSnapshot): GraphBindingContext {
	return {
		input: snapshot.input,
		state: snapshot.state,
		results: snapshot.results,
		runtime: runtimeContext(snapshot),
	};
}

function toResult(snapshot: GraphRunSnapshot): GraphRunResult {
	return {
		runId: snapshot.runId,
		unit: snapshot.unit,
		status: snapshot.status,
		...(snapshot.output !== undefined ? { output: snapshot.output } : {}),
		state: snapshot.state,
		results: snapshot.results,
		runtime: runtimeContext(snapshot),
		...(snapshot.review ? { review: snapshot.review } : {}),
		...(snapshot.error ? { error: snapshot.error } : {}),
	};
}

function checkpointId(snapshot: GraphRunSnapshot, nodeId: string, visit: number, phase: "before" | "after"): string {
	return `${snapshot.runId}:${nodeId}:${visit}:${phase}`;
}

function entriesFor(definition: GraphUnitDefinition): string[] {
	if (definition.entry) return typeof definition.entry === "string" ? [definition.entry] : definition.entry;
	const targets = new Set((definition.edges ?? []).map((edge) => edge.to));
	return Object.keys(definition.nodes).filter((id) => !targets.has(id));
}

function hasPendingTriggers(snapshot: GraphRunSnapshot): boolean {
	return Object.values(snapshot.pendingTriggers).some((triggers) => triggers.length > 0);
}

function removeReady(snapshot: GraphRunSnapshot, nodeId: string): void {
	const index = snapshot.ready.indexOf(nodeId);
	if (index >= 0) snapshot.ready.splice(index, 1);
}

function mergeStatePatch(snapshot: GraphRunSnapshot, patch: Record<string, unknown> | undefined): void {
	if (patch) Object.assign(snapshot.state, patch);
}

function resolveNodeValues(
	snapshot: GraphRunSnapshot,
	node: GraphNodeDefinition,
	inputOverride: unknown,
): { input: unknown; params: unknown } {
	const context = bindingContext(snapshot);
	const input = inputOverride !== undefined ? inputOverride : resolveBindings(node.input ?? { $ref: "input" }, context);
	const params = node.type === "code" && node.params !== undefined ? resolveBindings(node.params, context) : {};
	return { input, params };
}

function createReviewRequest(
	snapshot: GraphRunSnapshot,
	nodeId: string,
	node: GraphNodeDefinition,
	visit: number,
	phase: "before" | "after",
	input: unknown,
	output?: unknown,
): ReviewRequest {
	return {
		checkpointId: checkpointId(snapshot, nodeId, visit, phase),
		runId: snapshot.runId,
		unit: snapshot.unit,
		node: nodeId,
		phase,
		visit,
		...(node.review?.message ? { message: node.review.message } : {}),
		input,
		...(output !== undefined ? { output } : {}),
	};
}

export class GraphExecutor {
	private readonly options: GraphExecutionOptions;

	constructor(options: GraphExecutionOptions) {
		this.options = options;
	}

	private async persist(
		snapshot: GraphRunSnapshot,
		type: GraphRunEventType,
		options: { node?: string; details?: Record<string, unknown>; initialize?: boolean } = {},
	): Promise<void> {
		snapshot.sequence++;
		snapshot.updatedAt = new Date().toISOString();
		const event = {
			type,
			runId: snapshot.runId,
			sequence: snapshot.sequence,
			timestamp: snapshot.updatedAt,
			...(options.node ? { node: options.node } : {}),
			...(options.details ? { details: options.details } : {}),
		};
		if (options.initialize) await this.options.store.initialize(snapshot, event);
		else await this.options.store.record(snapshot, event);
	}

	private cancelPendingNodes(snapshot: GraphRunSnapshot): void {
		for (const node of Object.values(snapshot.nodes)) {
			if (node.status === "pending" || node.status === "running" || node.status === "waiting_review") {
				node.status = "cancelled";
			}
		}
		snapshot.ready = [];
		delete snapshot.review;
		snapshot.reviewQueue = [];
	}

	private async failRun(snapshot: GraphRunSnapshot, error: unknown): Promise<GraphRunResult> {
		snapshot.status = "failed";
		snapshot.error = errorMessage(error);
		this.cancelPendingNodes(snapshot);
		await this.persist(snapshot, "run_failed", { details: { error: snapshot.error } });
		return toResult(snapshot);
	}

	private edgeSources(target: string): string[] {
		return Array.from(
			new Set((this.options.definition.edges ?? []).filter((edge) => edge.to === target).map((edge) => edge.from)),
		);
	}

	private activateTarget(snapshot: GraphRunSnapshot, target: string, source: string): void {
		const pending = snapshot.pendingTriggers[target] ?? [];
		if (!pending.includes(source)) pending.push(source);
		snapshot.pendingTriggers[target] = pending;
		const node = this.options.definition.nodes[target];
		if (!node) throw new Error(`Unknown graph node: ${target}`);
		const ready =
			node.join === "any" || this.edgeSources(target).every((requiredSource) => pending.includes(requiredSource));
		if (!ready || snapshot.ready.includes(target)) return;
		snapshot.pendingTriggers[target] = [];
		snapshot.ready.push(target);
		if (snapshot.nodes[target]) snapshot.nodes[target].status = "pending";
	}

	private propagate(snapshot: GraphRunSnapshot, nodeId: string): void {
		const node = this.options.definition.nodes[nodeId];
		if (!node) throw new Error(`Unknown graph node: ${nodeId}`);
		const matching = (this.options.definition.edges ?? []).filter(
			(edge) => edge.from === nodeId && conditionMatches(edge.when, bindingContext(snapshot)),
		);
		const selected = node.edgeMode === "first" ? matching.slice(0, 1) : matching;
		for (const edge of selected) this.activateTarget(snapshot, edge.to, edge.from);
	}

	private finalizeNode(snapshot: GraphRunSnapshot, result: GraphNodeResult): void {
		snapshot.results[result.id] = result;
		const runtime = snapshot.nodes[result.id];
		if (!runtime) throw new Error(`Unknown graph node: ${result.id}`);
		runtime.status = result.status;
		runtime.attempts = result.attempts;
		mergeStatePatch(snapshot, result.statePatch);
		snapshot.lastOutput = result.output;
		this.propagate(snapshot, result.id);
	}

	private async requestReview(snapshot: GraphRunSnapshot, request: ReviewRequest): Promise<GraphRunResult> {
		snapshot.status = "waiting_review";
		snapshot.review = request;
		const node = snapshot.nodes[request.node];
		if (node) node.status = "waiting_review";
		await this.persist(snapshot, "review_requested", {
			node: request.node,
			details: { checkpointId: request.checkpointId, phase: request.phase, visit: request.visit },
		});
		return toResult(snapshot);
	}

	private async requestNextQueuedReview(snapshot: GraphRunSnapshot): Promise<GraphRunResult | undefined> {
		const request = snapshot.reviewQueue.shift();
		return request ? this.requestReview(snapshot, request) : undefined;
	}

	private async checkBeforeReview(snapshot: GraphRunSnapshot): Promise<GraphRunResult | undefined> {
		for (const nodeId of snapshot.ready) {
			const node = this.options.definition.nodes[nodeId];
			const runtime = snapshot.nodes[nodeId];
			if (!node || !runtime || node.review?.before !== true) continue;
			const visit = runtime.visits + 1;
			const id = checkpointId(snapshot, nodeId, visit, "before");
			if (snapshot.approvedReviews.includes(id)) continue;
			const values = resolveNodeValues(snapshot, node, snapshot.inputOverrides[id]);
			return this.requestReview(snapshot, createReviewRequest(snapshot, nodeId, node, visit, "before", values.input));
		}
		return undefined;
	}

	private takeBatch(snapshot: GraphRunSnapshot): string[] {
		const maximum = this.options.definition.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
		const selected: string[] = [];
		const concurrencyKeys = new Set<string>();
		for (const nodeId of snapshot.ready) {
			const node = this.options.definition.nodes[nodeId];
			if (!node) throw new Error(`Unknown graph node: ${nodeId}`);
			if (node.concurrencyKey && concurrencyKeys.has(node.concurrencyKey)) continue;
			selected.push(nodeId);
			if (node.concurrencyKey) concurrencyKeys.add(node.concurrencyKey);
			if (selected.length >= maximum) break;
		}
		for (const nodeId of selected) removeReady(snapshot, nodeId);
		return selected;
	}

	private prepareExecution(snapshot: GraphRunSnapshot, nodeId: string): NodeExecution {
		const node = this.options.definition.nodes[nodeId];
		const runtime = snapshot.nodes[nodeId];
		if (!node || !runtime) throw new Error(`Unknown graph node: ${nodeId}`);
		const visit = runtime.visits + 1;
		const maximumVisits = this.options.definition.maxVisits ?? DEFAULT_MAX_VISITS;
		if (visit > maximumVisits) throw new Error(`Maximum visits exceeded for node "${nodeId}" (${maximumVisits})`);
		const maximumSteps = this.options.definition.maxSteps ?? DEFAULT_MAX_STEPS;
		if (snapshot.stepCount + 1 > maximumSteps) throw new Error(`Maximum graph steps exceeded (${maximumSteps})`);
		const beforeId = checkpointId(snapshot, nodeId, visit, "before");
		const values = resolveNodeValues(snapshot, node, snapshot.inputOverrides[beforeId]);
		runtime.status = "running";
		runtime.visits = visit;
		runtime.attempts = 0;
		snapshot.stepCount++;
		return { nodeId, node, input: values.input, params: values.params, visit, startedAt: new Date().toISOString() };
	}

	private async runWithTimeout<T>(
		operation: (signal: AbortSignal) => Promise<T>,
		timeoutMs: number | undefined,
	): Promise<T> {
		const controller = new AbortController();
		const signals = [controller.signal, ...(this.options.signal ? [this.options.signal] : [])];
		const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
		if (!signal) throw new Error("Unable to create abort signal");
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			if (timeoutMs === undefined) return await operation(signal);
			return await Promise.race([
				operation(signal),
				new Promise<T>((_resolve, reject) => {
					timer = setTimeout(() => {
						controller.abort();
						reject(new Error(`Node timed out after ${timeoutMs} ms`));
					}, timeoutMs);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	private async executeNode(snapshot: GraphRunSnapshot, execution: NodeExecution): Promise<GraphNodeResult> {
		const maximumAttempts = (execution.node.retry ?? 0) + 1;
		let attempts = 0;
		let lastError: unknown;
		for (let attempt = 1; attempt <= maximumAttempts; attempt++) {
			attempts = attempt;
			try {
				const result = await this.runWithTimeout(async (signal) => {
					if (signal.aborted) throw new Error("Operation aborted");
					if (execution.node.type === "agent") {
						return { output: await this.options.runner.runAgent(execution.node.unit, execution.input, signal) };
					}
					return this.options.runner.runCode({
						entry: execution.node.entry,
						unitDirectory: this.options.unitDirectory,
						input: execution.input,
						params: execution.params,
						state: structuredClone(snapshot.state),
						signal,
						runtime: { ...runtimeContext(snapshot), node: execution.nodeId, visit: execution.visit },
					});
				}, execution.node.timeoutMs);
				return {
					id: execution.nodeId,
					type: execution.node.type,
					status: "succeeded",
					visit: execution.visit,
					attempts: attempt,
					output: result.output,
					...(result.statePatch ? { statePatch: result.statePatch } : {}),
					startedAt: execution.startedAt,
					completedAt: new Date().toISOString(),
				};
			} catch (error) {
				lastError = error;
				if (this.options.signal?.aborted) break;
			}
		}
		return {
			id: execution.nodeId,
			type: execution.node.type,
			status: "failed",
			visit: execution.visit,
			attempts,
			error: errorMessage(lastError),
			startedAt: execution.startedAt,
			completedAt: new Date().toISOString(),
		};
	}

	private async finish(snapshot: GraphRunSnapshot): Promise<GraphRunResult> {
		if (hasPendingTriggers(snapshot)) return this.failRun(snapshot, "Graph stopped with an incomplete join");
		try {
			snapshot.output =
				this.options.definition.output !== undefined
					? resolveBindings(this.options.definition.output, bindingContext(snapshot))
					: snapshot.lastOutput;
			snapshot.status = "succeeded";
			await this.persist(snapshot, "run_succeeded");
			return toResult(snapshot);
		} catch (error) {
			return this.failRun(snapshot, error);
		}
	}

	private async executeUntilPause(snapshot: GraphRunSnapshot): Promise<GraphRunResult> {
		while (snapshot.status === "running") {
			if (this.options.signal?.aborted) {
				snapshot.status = "aborted";
				this.cancelPendingNodes(snapshot);
				await this.persist(snapshot, "run_aborted");
				return toResult(snapshot);
			}
			const queuedReview = await this.requestNextQueuedReview(snapshot);
			if (queuedReview) return queuedReview;
			let beforeReview: GraphRunResult | undefined;
			try {
				beforeReview = await this.checkBeforeReview(snapshot);
			} catch (error) {
				return this.failRun(snapshot, error);
			}
			if (beforeReview) return beforeReview;
			if (snapshot.ready.length === 0) return this.finish(snapshot);

			let executions: NodeExecution[];
			try {
				executions = this.takeBatch(snapshot).map((nodeId) => this.prepareExecution(snapshot, nodeId));
			} catch (error) {
				return this.failRun(snapshot, error);
			}
			for (const execution of executions) {
				await this.persist(snapshot, "node_started", {
					node: execution.nodeId,
					details: { visit: execution.visit },
				});
			}

			const completed = await Promise.all(executions.map((execution) => this.executeNode(snapshot, execution)));
			if (this.options.signal?.aborted) {
				snapshot.status = "aborted";
				this.cancelPendingNodes(snapshot);
				await this.persist(snapshot, "run_aborted");
				return toResult(snapshot);
			}
			const hasFailure = completed.some((result) => result.status === "failed");
			for (const result of completed) {
				const execution = executions.find((candidate) => candidate.nodeId === result.id);
				if (!execution) throw new Error(`Missing node execution: ${result.id}`);
				const runtime = snapshot.nodes[result.id];
				if (runtime) runtime.attempts = result.attempts;
				if (result.status === "failed") {
					snapshot.results[result.id] = result;
					if (runtime) runtime.status = "failed";
					await this.persist(snapshot, "node_failed", {
						node: result.id,
						details: { error: result.error ?? "Node failed", attempts: result.attempts, visit: result.visit },
					});
					continue;
				}
				if (!hasFailure && execution.node.review?.after === true) {
					const request = createReviewRequest(
						snapshot,
						result.id,
						execution.node,
						result.visit,
						"after",
						execution.input,
						result.output,
					);
					snapshot.staged[request.checkpointId] = { input: execution.input, result };
					snapshot.reviewQueue.push(request);
					if (runtime) runtime.status = "waiting_review";
					continue;
				}
				this.finalizeNode(snapshot, result);
				await this.persist(snapshot, "node_succeeded", {
					node: result.id,
					details: { attempts: result.attempts, visit: result.visit },
				});
			}
			if (hasFailure) {
				const failure = completed.find((result) => result.status === "failed");
				return this.failRun(snapshot, failure?.error ?? "Graph node failed");
			}
		}
		return toResult(snapshot);
	}

	async start(options: {
		input: unknown;
		initialState?: Record<string, unknown>;
		runId?: string;
	}): Promise<GraphRunResult> {
		const now = new Date().toISOString();
		const nodes = Object.fromEntries(
			Object.keys(this.options.definition.nodes).map((id) => [
				id,
				{ status: "pending" as const, visits: 0, attempts: 0 },
			]),
		);
		const snapshot: GraphRunSnapshot = {
			version: 1,
			sequence: 0,
			runId: options.runId ?? createRunId(),
			unit: this.options.unit,
			status: "running",
			input: options.input,
			state: { ...(options.initialState ?? {}) },
			results: {},
			nodes,
			ready: entriesFor(this.options.definition),
			pendingTriggers: {},
			stepCount: 0,
			reviewQueue: [],
			staged: {},
			approvedReviews: [],
			inputOverrides: {},
			startedAt: now,
			updatedAt: now,
		};
		if (snapshot.ready.length === 0) throw new Error(`Graph unit "${snapshot.unit}" has no entry nodes`);
		if (this.options.definition.initialState) {
			const resolved = resolveBindings(
				this.options.definition.initialState as Record<string, BindingValue>,
				bindingContext(snapshot),
			);
			if (typeof resolved !== "object" || resolved === null || Array.isArray(resolved)) {
				throw new Error("Graph initialState must resolve to an object");
			}
			Object.assign(snapshot.state, resolved);
		}
		await this.persist(snapshot, "run_started", { initialize: true });
		return this.executeUntilPause(snapshot);
	}

	private createSyntheticResult(
		request: ReviewRequest,
		status: "succeeded" | "skipped",
		decision: ReviewDecision,
	): GraphNodeResult {
		const node = this.options.definition.nodes[request.node];
		if (!node) throw new Error(`Unknown graph node: ${request.node}`);
		const now = new Date().toISOString();
		return {
			id: request.node,
			type: node.type,
			status,
			visit: request.visit,
			attempts: 0,
			output: decision.value ?? null,
			...(decision.statePatch ? { statePatch: decision.statePatch } : {}),
			startedAt: now,
			completedAt: now,
		};
	}

	private async applyReviewDecision(snapshot: GraphRunSnapshot, decision: ReviewDecision): Promise<void> {
		const request = snapshot.review;
		if (!request) throw new Error(`Run "${snapshot.runId}" is not waiting for review`);
		const node = this.options.definition.nodes[request.node];
		const runtime = snapshot.nodes[request.node];
		if (!node || !runtime) throw new Error(`Unknown graph node: ${request.node}`);
		delete snapshot.review;
		snapshot.status = "running";
		mergeStatePatch(snapshot, decision.statePatch);

		if (decision.action === "abort") {
			snapshot.status = "aborted";
			this.cancelPendingNodes(snapshot);
		} else if (request.phase === "before") {
			if (decision.action === "approve" || decision.action === "retry" || decision.action === "edit") {
				if (decision.action === "edit") snapshot.inputOverrides[request.checkpointId] = decision.value;
				if (!snapshot.approvedReviews.includes(request.checkpointId)) {
					snapshot.approvedReviews.push(request.checkpointId);
				}
				runtime.status = "pending";
			} else {
				removeReady(snapshot, request.node);
				runtime.visits = request.visit;
				snapshot.stepCount++;
				const status = decision.action === "skip" ? "skipped" : "succeeded";
				this.finalizeNode(snapshot, this.createSyntheticResult(request, status, decision));
			}
		} else {
			const staged = snapshot.staged[request.checkpointId];
			if (!staged) throw new Error(`Missing staged result for checkpoint: ${request.checkpointId}`);
			delete snapshot.staged[request.checkpointId];
			if (decision.action === "retry") {
				runtime.status = "pending";
				snapshot.ready.unshift(request.node);
			} else {
				const result = { ...staged.result };
				if (decision.action === "skip") {
					result.status = "skipped";
					result.output = decision.value ?? null;
					if (decision.statePatch) result.statePatch = decision.statePatch;
					else delete result.statePatch;
				} else if (["edit", "override", "takeover"].includes(decision.action)) {
					result.output = decision.value;
					if (decision.statePatch) result.statePatch = decision.statePatch;
				}
				this.finalizeNode(snapshot, result);
			}
		}

		await this.persist(snapshot, "review_decided", {
			node: request.node,
			details: { checkpointId: request.checkpointId, action: decision.action, phase: request.phase },
		});
		if (snapshot.status === "aborted") await this.persist(snapshot, "run_aborted");
	}

	async resume(snapshot: GraphRunSnapshot, decision: ReviewDecision): Promise<GraphRunResult> {
		if (snapshot.unit !== this.options.unit) {
			throw new Error(`Run "${snapshot.runId}" belongs to unit "${snapshot.unit}", not "${this.options.unit}"`);
		}
		if (snapshot.status !== "waiting_review" || !snapshot.review) {
			throw new Error(`Run "${snapshot.runId}" is not waiting for review`);
		}
		await this.applyReviewDecision(snapshot, decision);
		return (snapshot as GraphRunSnapshot).status === "running" ? this.executeUntilPause(snapshot) : toResult(snapshot);
	}
}

export async function runGraph(options: StartGraphOptions): Promise<GraphRunResult> {
	const executor = new GraphExecutor(options);
	return executor.start({
		input: options.input,
		...(options.initialState ? { initialState: options.initialState } : {}),
		...(options.runId ? { runId: options.runId } : {}),
	});
}
