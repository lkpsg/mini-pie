import { access, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

function isInside(root: string, target: string): boolean {
	const path = relative(root, target);
	return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function nearestExistingPath(path: string): Promise<string> {
	let current = path;
	while (true) {
		try {
			await access(current);
			return current;
		} catch {
			const parent = dirname(current);
			if (parent === current) return current;
			current = parent;
		}
	}
}

export async function resolveWorkspacePath(workspace: string, requestedPath: string): Promise<string> {
	if (
		requestedPath === "~" ||
		requestedPath.startsWith("~/") ||
		requestedPath.startsWith("~\\") ||
		requestedPath.startsWith("file://")
	) {
		throw new Error(`Special path syntax is not allowed: ${requestedPath}`);
	}
	const absoluteWorkspace = resolve(workspace);
	const target = isAbsolute(requestedPath) ? resolve(requestedPath) : resolve(absoluteWorkspace, requestedPath);
	if (!isInside(absoluteWorkspace, target)) {
		throw new Error(`Path is outside the workspace: ${requestedPath}`);
	}

	const canonicalWorkspace = await realpath(absoluteWorkspace);
	const existing = await nearestExistingPath(target);
	const canonicalExisting = await realpath(existing);
	if (!isInside(canonicalWorkspace, canonicalExisting)) {
		throw new Error(`Path resolves outside the workspace: ${requestedPath}`);
	}
	return target;
}

export async function guardToolPath(workspace: string, toolName: string, argumentsValue: unknown): Promise<void> {
	if (!["read", "write", "edit", "grep", "find", "ls", "apply_patch"].includes(toolName)) return;
	if (typeof argumentsValue !== "object" || argumentsValue === null) return;
	const path = (argumentsValue as Record<string, unknown>).path;
	if (typeof path === "string") await resolveWorkspacePath(workspace, path);
}
