import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	isNativeExportRunning,
	NativeExportSession,
	type NativeExportOptions,
	subscribeNativeExports,
} from "../native";
import { isExportPriority, useExportPriorityStore } from "../priority";

// What the desktop app is asked, and whether finishing fails.
const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
let finishFails = false;
const globals = globalThis as Record<string, unknown>;
beforeAll(() => {
	globals.window ??= globalThis;
	globals.isTauri = true;
	globals.__TAURI_INTERNALS__ = {
		invoke: (...[command, args]: [string, Record<string, unknown>]) =>
			Promise.resolve().then(() => {
				calls.push({ command, args });
				if (command === "native_export_start") return 7;
				if (command === "native_export_finish" && finishFails) {
					throw new Error("the disk is full");
				}
				return null;
			}),
	};
});
afterAll(() => {
	delete globals.isTauri;
	delete globals.__TAURI_INTERNALS__;
});

const options: NativeExportOptions = {
	path: "/Movies/Trip.mp4",
	format: "mp4",
	width: 1920,
	height: 1080,
	outputWidth: 1920,
	outputHeight: 1080,
	fps: { numerator: 30, denominator: 1 },
	videoCodec: "av1",
	videoBitrate: 8_000_000,
	audio: null,
};

describe("an export's priority", () => {
	test("is the one chosen, and a change goes to the app at once", async () => {
		calls.length = 0;
		useExportPriorityStore.getState().setPriority({ priority: "background" });
		await NativeExportSession.start({ options }).then((session) =>
			session.cancel(),
		);
		const [changed, started] = calls;
		expect(changed).toEqual({
			command: "native_export_priority",
			args: { priority: "background" },
		});
		expect(started?.command).toBe("native_export_start");
		expect(started?.args.options).toMatchObject({ priority: "background" });
	});

	test("can be changed while it runs: until it's finished or stopped", async () => {
		finishFails = false;
		const seen: boolean[] = [];
		const stop = subscribeNativeExports(() =>
			seen.push(isNativeExportRunning()),
		);
		expect(isNativeExportRunning()).toBe(false);

		const finished = await NativeExportSession.start({ options });
		expect(isNativeExportRunning()).toBe(true);
		await finished.finish();
		expect(isNativeExportRunning()).toBe(false);

		const stopped = await NativeExportSession.start({ options });
		await stopped.cancel();
		// Stopping after it failed counts once.
		await stopped.cancel();
		expect(isNativeExportRunning()).toBe(false);

		finishFails = true;
		const failed = await NativeExportSession.start({ options });
		await expect(failed.finish()).rejects.toThrow("the disk is full");
		expect(isNativeExportRunning()).toBe(false);

		stop();
		expect(seen).toEqual([true, false, true, false, true, false]);
	});

	test("kept from another version only if it's one of these", () => {
		expect(isExportPriority("low")).toBe(true);
		expect(isExportPriority("realtime")).toBe(false);
		expect(isExportPriority(undefined)).toBe(false);
	});
});
