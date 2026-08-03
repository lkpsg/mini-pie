import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { type AgentMessage, uuidv7 } from "@earendil-works/pi-agent-core";

interface SessionLine {
	type: "message";
	message: AgentMessage;
}

function validateSessionId(sessionId: string): void {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(sessionId)) {
		throw new Error("Session id may contain only letters, numbers, dots, underscores, and hyphens");
	}
}

function isMessage(value: unknown): value is AgentMessage {
	return typeof value === "object" && value !== null && "role" in value && typeof value.role === "string";
}

export class JsonlSession {
	readonly id: string;
	readonly filePath: string;

	constructor(sessionId: string, directory: string) {
		validateSessionId(sessionId);
		this.id = sessionId;
		this.filePath = resolve(directory, `${sessionId}.jsonl`);
	}

	async load(): Promise<AgentMessage[]> {
		let text: string;
		try {
			text = await readFile(this.filePath, "utf8");
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
			throw error;
		}
		const messages: AgentMessage[] = [];
		for (const [index, line] of text.split("\n").entries()) {
			if (line.trim().length === 0) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line) as unknown;
			} catch (error) {
				throw new Error(`Invalid session JSON at ${this.filePath}:${index + 1}`, { cause: error });
			}
			if (
				typeof parsed !== "object" ||
				parsed === null ||
				!("type" in parsed) ||
				parsed.type !== "message" ||
				!("message" in parsed) ||
				!isMessage(parsed.message)
			) {
				throw new Error(`Invalid session entry at ${this.filePath}:${index + 1}`);
			}
			messages.push(parsed.message);
		}
		return messages;
	}

	async append(message: AgentMessage): Promise<void> {
		await mkdir(dirname(this.filePath), { recursive: true });
		const line: SessionLine = { type: "message", message };
		await appendFile(this.filePath, `${JSON.stringify(line)}\n`, "utf8");
	}
}

export function createSessionId(): string {
	return uuidv7();
}
