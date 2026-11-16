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
// window says which, with Stop. A call the app gives up on (it timed out, or
// the agent was revoked, or agent mode switched off) is dropped if it hasn't
// started, and stopped if it has.

interface ToolCall {
	call: number;
	tool: string;
	arguments: Record<string, unknown>;
	agent: string;
}

function failure({ message }: { message: string }): ToolResult {
	return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * What a call answers: its result, unless it was stopped before it had
 * finished, which it shows by having seen `isStopped` say so. A tool that
 * had done its work when Stop was pressed answers as it did.
 */
export function answerOf({
	result,
	sawStop,
}: {
	result: ToolResult;
	sawStop: boolean;
}): ToolResult {
	if (!sawStop || result.isError) return result;
	const done = result.content
		.flatMap((item) => (item.type === "text" ? [item.text] : []))
		.join("\n");
	return failure({
		message: done
			? `Stopped by the user before it had finished; so far: ${done}`
			: "Stopped by the user",
	});
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
		let queue = Promise.resolve();
		let running: number | null = null;
		// Calls the app gave up on before they started.
		const dropped = new Set<number>();
		const run = async (call: ToolCall) => {
			if (dropped.delete(call.call)) return;
			const tool = TOOLS.find((candidate) => candidate.name === call.tool);
			running = call.call;
			stopped.current = false;
			let sawStop = false;
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
						isStopped: () => {
							if (stopped.current) sawStop = true;
							return stopped.current;
						},
					},
				});
				result = answerOf({ result, sawStop });
			} catch (error) {
				result = failure({
					message:
						error instanceof ToolError
							? error.message
							: `Something went wrong: ${error instanceof Error ? error.message : String(error)}`,
				});
			}
			running = null;
			setWorking(null);
			await invoke("agent_reply", { call: call.call, result });
		};
		const listening = Promise.all([
			listen<ToolCall>("agent", ({ payload }) => {
				// One at a time: two agents' edits don't interleave.
				queue = queue.then(() => run(payload)).catch(() => {});
			}),
			listen<number[]>("agent-cancel", ({ payload }) => {
				for (const call of payload) {
					if (call === running) stopped.current = true;
					else dropped.add(call);
				}
			}),
		]);
		let disposed = false;
		// The tools said only once this listens: the app sends no call before.
		void listening
			.then(() => {
				if (disposed) return;
				return invoke("agent_register_tools", {
					tools: TOOLS.map(({ name, description, inputSchema }) => ({
						name,
						description,
						inputSchema,
					})),
				});
			})
			.catch(() => {});
		return () => {
			disposed = true;
			void listening
				.then((stops) => {
					for (const stop of stops) stop();
				})
				.catch(() => {});
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
