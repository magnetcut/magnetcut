import { describe, expect, test } from "bun:test";
import { answerOf } from "../bridge";
import type { ToolResult } from "../tools-base";

const saved: ToolResult = {
	content: [{ type: "text", text: "saved /films/trip.magnetcut" }],
};

describe("what a call answers once Stop is pressed", () => {
	test("a tool that had done its work answers as it did", () => {
		expect(answerOf({ result: saved, sawStop: false })).toEqual(saved);
	});

	test("one cut short says so, with what it had done", () => {
		const shots: ToolResult = {
			content: [{ type: "text", text: "2 cuts, at 1.00 4.00" }],
		};
		expect(answerOf({ result: shots, sawStop: true })).toEqual({
			content: [
				{
					type: "text",
					text: "Stopped by the user before it had finished; so far: 2 cuts, at 1.00 4.00",
				},
			],
			isError: true,
		});
		expect(
			answerOf({
				result: { content: [{ type: "image", data: "", mimeType: "x" }] },
				sawStop: true,
			}),
		).toEqual({
			content: [{ type: "text", text: "Stopped by the user" }],
			isError: true,
		});
	});

	test("a failure stays the tool's own", () => {
		const failed: ToolResult = {
			content: [{ type: "text", text: "The export was stopped" }],
			isError: true,
		};
		expect(answerOf({ result: failed, sawStop: true })).toEqual(failed);
	});
});
