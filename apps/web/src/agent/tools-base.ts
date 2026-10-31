import type { EditorCore } from "@/core";

// What every agent tool is (docs/AUTOMATION.md): its name, a short
// description, its arguments' schema, and its work, with what it may use.

export type ToolContent =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string };

export interface ToolResult {
	content: ToolContent[];
	isError?: boolean;
}

export interface ToolContext {
	editor: EditorCore;
	/** The call's number, which the app checks paths against. */
	call: number;
	agent: string;
	navigate: (url: string) => void;
	progress: (update: {
		progress: number;
		total?: number;
		message?: string;
	}) => void;
	isStopped: () => boolean;
}

export interface Tool {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	run: (call: {
		args: Record<string, unknown>;
		context: ToolContext;
	}) => Promise<ToolResult>;
}

/** A failure the agent reads and can act on. */
export class ToolError extends Error {}

/** A short fingerprint of the timeline: it changes when anything on it does. */
export function revisionOf({ value }: { value: unknown }): string {
	const json = JSON.stringify(value, (key, item: unknown) =>
		key === "buffer" ? undefined : item,
	);
	let hash = 0x811c9dc5;
	for (let i = 0; i < json.length; i++) {
		hash ^= json.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0").slice(0, 6);
}
