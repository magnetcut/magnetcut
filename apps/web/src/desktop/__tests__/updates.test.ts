import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { useSettingsStore } from "../settings-store";
import { checkForUpdatesIfDue } from "../updates";

// What the desktop app would answer: an edition that updates itself, and a
// feed that can't be read.
const commands: string[] = [];
function fakeInvoke({ command }: { command: string }) {
	commands.push(command);
	if (command === "app_info") return { version: "1.0.0", updates: true };
	if (command === "plugin:updater|check") {
		throw new Error("Could not fetch a valid release JSON from the remote");
	}
	throw new Error(`unexpected command ${command}`);
}

const globals = globalThis as Record<string, unknown>;
beforeAll(() => {
	globals.window ??= globalThis;
	globals.isTauri = true;
	globals.__TAURI_INTERNALS__ = {
		invoke: (command: string) =>
			Promise.resolve().then(() => fakeInvoke({ command })),
	};
});
afterAll(() => {
	delete globals.isTauri;
	delete globals.__TAURI_INTERNALS__;
});

describe("the daily check", () => {
	test("that fails isn't tried again within the day", async () => {
		useSettingsStore.setState({
			checksForUpdates: true,
			lastUpdateCheck: null,
		});

		await checkForUpdatesIfDue();
		await checkForUpdatesIfDue();

		expect(
			commands.filter((command) => command === "plugin:updater|check"),
		).toHaveLength(1);
		expect(useSettingsStore.getState().lastUpdateCheck).toBeNull();
	});
});
