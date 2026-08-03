import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

const httpRequestSchema = Type.Object({
	url: Type.String({ description: "HTTP or HTTPS URL" }),
	method: Type.Optional(
		Type.Union([
			Type.Literal("GET"),
			Type.Literal("POST"),
			Type.Literal("PUT"),
			Type.Literal("PATCH"),
			Type.Literal("DELETE"),
		]),
	),
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
	body: Type.Optional(Type.String()),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 120_000 })),
});

function createHttpRequestTool(): AgentTool<typeof httpRequestSchema, { status: number; truncated: boolean }> {
	return {
		name: "http_request",
		label: "http_request",
		description: "Make an HTTP request. Response bodies are truncated to 100 KB.",
		parameters: httpRequestSchema,
		async execute(_id, { url, method = "GET", headers, body, timeoutMs = 30_000 }, signal) {
			const parsed = new URL(url);
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
				throw new Error("Only HTTP and HTTPS URLs are supported");
			}
			const timeoutSignal = AbortSignal.timeout(timeoutMs);
			const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
			const response = await fetch(parsed, {
				method,
				...(headers ? { headers } : {}),
				...(body !== undefined ? { body } : {}),
				signal: requestSignal,
			});
			const responseBody = await response.text();
			const limit = 100_000;
			const truncated = responseBody.length > limit;
			const displayedBody = truncated ? `${responseBody.slice(0, limit)}\n[Response truncated]` : responseBody;
			const headerText = Array.from(response.headers.entries())
				.map(([name, value]) => `${name}: ${value}`)
				.join("\n");
			return {
				content: [
					{
						type: "text",
						text: `HTTP ${response.status} ${response.statusText}\n${headerText}\n\n${displayedBody}`,
					},
				],
				details: { status: response.status, truncated },
			};
		},
	};
}

const sleepSchema = Type.Object({
	milliseconds: Type.Integer({ minimum: 1, maximum: 60_000 }),
});

function createSleepTool(): AgentTool<typeof sleepSchema, { milliseconds: number }> {
	return {
		name: "sleep",
		label: "sleep",
		description: "Wait for up to 60 seconds. The wait can be aborted.",
		parameters: sleepSchema,
		async execute(_id, { milliseconds }, signal) {
			await new Promise<void>((resolve, reject) => {
				const onAbort = () => {
					clearTimeout(timer);
					reject(new Error("Operation aborted"));
				};
				const timer = setTimeout(() => {
					signal?.removeEventListener("abort", onAbort);
					resolve();
				}, milliseconds);
				if (signal?.aborted) onAbort();
				else signal?.addEventListener("abort", onAbort, { once: true });
			});
			return {
				content: [{ type: "text", text: `Waited ${milliseconds} ms` }],
				details: { milliseconds },
			};
		},
	};
}

type TodoStatus = "pending" | "in_progress" | "completed";

interface TodoItem {
	id: number;
	text: string;
	status: TodoStatus;
}

const todoSchema = Type.Object({
	action: Type.Union([Type.Literal("list"), Type.Literal("add"), Type.Literal("update"), Type.Literal("remove")]),
	id: Type.Optional(Type.Integer({ minimum: 1 })),
	text: Type.Optional(Type.String({ minLength: 1 })),
	status: Type.Optional(Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")])),
});

function createTodoTool(): AgentTool<typeof todoSchema, { items: TodoItem[] }> {
	const items: TodoItem[] = [];
	let nextId = 1;
	return {
		name: "todo",
		label: "todo",
		description: "Maintain an in-memory task list for the current agent instance.",
		parameters: todoSchema,
		executionMode: "sequential",
		async execute(_id, { action, id, text, status }) {
			if (action === "add") {
				if (!text) throw new Error("text is required when action is add");
				items.push({ id: nextId++, text, status: status ?? "pending" });
			} else if (action === "update") {
				if (id === undefined) throw new Error("id is required when action is update");
				const item = items.find((candidate) => candidate.id === id);
				if (!item) throw new Error(`Todo ${id} was not found`);
				if (text !== undefined) item.text = text;
				if (status !== undefined) item.status = status;
			} else if (action === "remove") {
				if (id === undefined) throw new Error("id is required when action is remove");
				const index = items.findIndex((candidate) => candidate.id === id);
				if (index < 0) throw new Error(`Todo ${id} was not found`);
				items.splice(index, 1);
			}
			const snapshot = items.map((item) => ({ ...item }));
			return {
				content: [{ type: "text", text: JSON.stringify(snapshot, null, 2) }],
				details: { items: snapshot },
			};
		},
	};
}

export function createMiscTools(): AgentTool[] {
	return [createHttpRequestTool(), createSleepTool(), createTodoTool()];
}
