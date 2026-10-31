"use client";

import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { EditorCore } from "@/core";
import { TOOLS, ToolError, type ToolResult } from "./tools";

// The editor's side of agent mode (docs/AUTOMATION.md): the app serves MCP
// and hands each tool call here (apps/desktop/src/agent/); it's done, one at
// a time, and answered. While an agent works, a strip at the top of the
// window says which, with Stop.

interface ToolCall {
	call: number;
	tool: string;
	arguments: Record<string, unknown>;
	agent: string;
}

function failure({ message }: { message: string }): ToolResult {
	return { content: [{ type: "text", text: message }], isError: true };
}

/** Runs the agents' calls, in the root layout: on every page, once. */
export function AgentBridge() {
	const router = useRouter();
	const [working, setWorking] = useState<{
		agent: string;
		tool: string;
	} | null>(null);
	const stopped = useRef(false);

	useEffect(() => {
		if (!isTauri()) return;
		void invoke("agent_register_tools", {
			tools: TOOLS.map(({ name, description, inputSchema }) => ({
				name,
				description,
				inputSchema,
			})),
		});
		let queue = Promise.resolve();
		const run = async (call: ToolCall) => {
			const tool = TOOLS.find((candidate) => candidate.name === call.tool);
			stopped.current = false;
			setWorking({ agent: call.agent, tool: call.tool });
			let result: ToolResult;
			try {
				if (!tool) throw new ToolError(`No tool ${call.tool}`);
				result = await tool.run({
					args: call.arguments ?? {},
					context: {
						editor: EditorCore.getInstance(),
						call: call.call,
						agent: call.agent,
						navigate: (url) => router.push(url),
						progress: ({ progress, total, message }) =>
							void invoke("agent_progress", {
								call: call.call,
								progress,
								total,
								message,
							}),
						isStopped: () => stopped.current,
					},
				});
				if (stopped.current) {
					result = failure({ message: "Stopped by the user" });
				}
			} catch (error) {
				result = failure({
					message:
						error instanceof ToolError
							? error.message
							: `Something went wrong: ${error instanceof Error ? error.message : String(error)}`,
				});
			}
			setWorking(null);
			await invoke("agent_reply", { call: call.call, result });
		};
		const unlisten = listen<ToolCall>("agent", ({ payload }) => {
			// One at a time: two agents' edits don't interleave.
			queue = queue.then(() => run(payload)).catch(() => {});
		});
		return () => {
			void unlisten.then((stop) => stop());
		};
	}, [router]);

	if (!working) return null;
	return (
		<div className="bg-primary text-primary-foreground fixed inset-x-0 top-0 z-[100] flex items-center justify-center gap-3 px-3 py-1 text-xs">
			<span>
				{working.agent} is using MagnetCut ({working.tool})
			</span>
			<Button
				size="sm"
				variant="secondary"
				className="h-6"
				onClick={() => {
					stopped.current = true;
				}}
			>
				Stop
			</Button>
		</div>
	);
}
