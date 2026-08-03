import { pathToFileURL } from "node:url";
import type { Static, TSchema } from "@earendil-works/pi-ai";
import { Check, Errors } from "typebox/value";
import type { CodeNodeDefinition, CodeNodeRunContext, CodeNodeRunResult, GraphRuntimeContext } from "./types.ts";
import { resolveWorkspacePath } from "./workspace.ts";

type RuntimeCodeNode = CodeNodeDefinition<TSchema, TSchema, TSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validationMessage(schema: TSchema, value: unknown): string {
	const error = Errors(schema, value)[0];
	return error ? `${error.instancePath || "/"}: ${error.message}` : "value does not match schema";
}

function assertSchema(schema: TSchema, value: unknown, label: string): void {
	if (!Check(schema, value)) throw new Error(`${label} validation failed at ${validationMessage(schema, value)}`);
}

export function defineCodeNode<
	TInputSchema extends TSchema,
	TOutputSchema extends TSchema,
	TParamsSchema extends TSchema = TSchema,
>(
	definition: CodeNodeDefinition<TInputSchema, TOutputSchema, TParamsSchema>,
): CodeNodeDefinition<TInputSchema, TOutputSchema, TParamsSchema> {
	return definition;
}

export class CodeNodeLoader {
	private readonly cache = new Map<string, RuntimeCodeNode>();

	async load(entry: string, unitDirectory: string): Promise<RuntimeCodeNode> {
		const separator = entry.lastIndexOf("#");
		if (separator <= 0 || separator === entry.length - 1) {
			throw new Error(`Code node entry must use ./file.ts#exportName: ${entry}`);
		}
		const modulePath = await resolveWorkspacePath(unitDirectory, entry.slice(0, separator));
		const exportName = entry.slice(separator + 1);
		const key = `${modulePath}#${exportName}`;
		const cached = this.cache.get(key);
		if (cached) return cached;

		const moduleValue: unknown = await import(pathToFileURL(modulePath).href);
		if (!isRecord(moduleValue)) throw new Error(`Code node module did not return exports: ${modulePath}`);
		const exported = moduleValue[exportName];
		if (
			!isRecord(exported) ||
			typeof exported.run !== "function" ||
			!isRecord(exported.input) ||
			!isRecord(exported.output)
		) {
			throw new Error(`Export "${exportName}" is not a code node definition: ${modulePath}`);
		}
		const definition = exported as unknown as RuntimeCodeNode;
		this.cache.set(key, definition);
		return definition;
	}

	async run(options: {
		entry: string;
		unitDirectory: string;
		input: unknown;
		params: unknown;
		state: Readonly<Record<string, unknown>>;
		signal: AbortSignal;
		runtime: Readonly<GraphRuntimeContext>;
	}): Promise<CodeNodeRunResult> {
		const definition = await this.load(options.entry, options.unitDirectory);
		assertSchema(definition.input, options.input, "Code node input");
		if (definition.params) assertSchema(definition.params, options.params, "Code node params");
		const context: CodeNodeRunContext = {
			input: options.input,
			params: options.params,
			state: options.state,
			signal: options.signal,
			runtime: options.runtime,
		};
		const result = (await definition.run(context)) as CodeNodeRunResult<Static<TSchema>>;
		if (!isRecord(result) || !("output" in result)) throw new Error("Code node must return { output, statePatch? }");
		assertSchema(definition.output, result.output, "Code node output");
		if (result.statePatch !== undefined && !isRecord(result.statePatch)) {
			throw new Error("Code node statePatch must be an object");
		}
		return result;
	}
}
