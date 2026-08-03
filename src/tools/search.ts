import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { resolveWorkspacePath } from "../workspace.ts";

const DEFAULT_IGNORED_DIRECTORIES = new Set([".git", ".mini-pie", "node_modules"]);
const MAX_FILES = 10_000;
const MAX_FILE_BYTES = 1_000_000;

async function walkFiles(root: string, signal?: AbortSignal): Promise<string[]> {
	const files: string[] = [];
	const pending = [root];
	while (pending.length > 0 && files.length < MAX_FILES) {
		if (signal?.aborted) throw new Error("Operation aborted");
		const directory = pending.pop();
		if (!directory) break;
		const entries = await readdir(directory, { withFileTypes: true });
		for (const entry of entries) {
			if (signal?.aborted) throw new Error("Operation aborted");
			if (entry.isSymbolicLink()) continue;
			const path = resolve(directory, entry.name);
			if (entry.isDirectory()) {
				if (!DEFAULT_IGNORED_DIRECTORIES.has(entry.name)) pending.push(path);
			} else if (entry.isFile()) {
				files.push(path);
				if (files.length >= MAX_FILES) break;
			}
		}
	}
	return files;
}

function globToRegExp(glob: string): RegExp {
	let source = "^";
	for (let index = 0; index < glob.length; index++) {
		const character = glob[index];
		if (character === "*") {
			if (glob[index + 1] === "*") {
				if (glob[index + 2] === "/") {
					source += "(?:.*/)?";
					index += 2;
				} else {
					source += ".*";
					index++;
				}
			} else {
				source += "[^/]*";
			}
		} else if (character === "?") {
			source += "[^/]";
		} else {
			source += character?.replace(/[|\\{}()[\]^$+?.]/g, "\\$&") ?? "";
		}
	}
	return new RegExp(`${source}$`);
}

function normalizedRelative(root: string, path: string): string {
	return relative(root, path).split(sep).join("/");
}

const grepSchema = Type.Object({
	pattern: Type.String({ description: "JavaScript regular expression to search for" }),
	path: Type.Optional(Type.String({ description: "File or directory to search; defaults to the workspace" })),
	include: Type.Optional(Type.String({ description: "Optional glob for relative file paths, for example **/*.ts" })),
	maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
});

const grepTool: (workspace: string) => AgentTool<typeof grepSchema, { matches: number; scannedFiles: number }> = (
	workspace,
) => ({
	name: "grep",
	label: "grep",
	description:
		"Search text files with a regular expression. Skips .git, .mini-pie, node_modules, symlinks, and large files.",
	parameters: grepSchema,
	async execute(_id, { pattern, path = ".", include, maxResults = 100 }, signal) {
		const target = await resolveWorkspacePath(workspace, path);
		const targetStat = await stat(target);
		const files = targetStat.isFile() ? [target] : await walkFiles(target, signal);
		const matcher = new RegExp(pattern, "u");
		const includeMatcher = include ? globToRegExp(include) : undefined;
		const lines: string[] = [];
		let scannedFiles = 0;
		for (const file of files) {
			if (signal?.aborted) throw new Error("Operation aborted");
			const fileStat = await stat(file);
			if (fileStat.size > MAX_FILE_BYTES) continue;
			const relativePath = normalizedRelative(targetStat.isFile() ? workspace : target, file);
			if (includeMatcher && !includeMatcher.test(relativePath)) continue;
			const content = await readFile(file, "utf8");
			scannedFiles++;
			const contentLines = content.split(/\r?\n/);
			for (let index = 0; index < contentLines.length; index++) {
				const line = contentLines[index] ?? "";
				matcher.lastIndex = 0;
				if (matcher.test(line)) lines.push(`${relativePath}:${index + 1}:${line}`);
				if (lines.length >= maxResults) break;
			}
			if (lines.length >= maxResults) break;
		}
		return {
			content: [{ type: "text", text: lines.length > 0 ? lines.join("\n") : "No matches found." }],
			details: { matches: lines.length, scannedFiles },
		};
	},
});

const findSchema = Type.Object({
	pattern: Type.String({ description: "Glob matched against relative paths or basenames, for example **/*.test.ts" }),
	path: Type.Optional(Type.String({ description: "Directory to search; defaults to the workspace" })),
	maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
});

const findTool: (workspace: string) => AgentTool<typeof findSchema, { matches: number }> = (workspace) => ({
	name: "find",
	label: "find",
	description: "Find files by glob. Skips .git, .mini-pie, node_modules, and symlinked directories.",
	parameters: findSchema,
	async execute(_id, { pattern, path = ".", maxResults = 200 }, signal) {
		const target = await resolveWorkspacePath(workspace, path);
		const matcher = globToRegExp(pattern);
		const files = await walkFiles(target, signal);
		const matches = files
			.map((file) => normalizedRelative(target, file))
			.filter((file) => matcher.test(file) || matcher.test(basename(file)))
			.slice(0, maxResults);
		return {
			content: [{ type: "text", text: matches.length > 0 ? matches.join("\n") : "No files found." }],
			details: { matches: matches.length },
		};
	},
});

const lsSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Directory to list; defaults to the workspace" })),
});

const lsTool: (workspace: string) => AgentTool<typeof lsSchema, { entries: number }> = (workspace) => ({
	name: "ls",
	label: "ls",
	description: "List direct children of a directory with type and size.",
	parameters: lsSchema,
	async execute(_id, { path = "." }) {
		const target = await resolveWorkspacePath(workspace, path);
		const entries = await readdir(target, { withFileTypes: true });
		const output = await Promise.all(
			entries
				.sort((left, right) => left.name.localeCompare(right.name))
				.map(async (entry) => {
					const info = await lstat(resolve(target, entry.name));
					const kind = entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file";
					return `${kind}\t${info.size}\t${entry.name}`;
				}),
		);
		return {
			content: [{ type: "text", text: output.length > 0 ? output.join("\n") : "Directory is empty." }],
			details: { entries: output.length },
		};
	},
});

export function createSearchTools(workspace: string): AgentTool[] {
	return [grepTool(workspace), findTool(workspace), lsTool(workspace)];
}
