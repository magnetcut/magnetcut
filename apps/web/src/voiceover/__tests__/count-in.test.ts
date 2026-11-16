import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import type { EditorCore } from "@/core";
import type { VoiceRecorder } from "../recorder";
import { cancelCountIn, startTake, useRecordingStore } from "../recording";

/**
 * A microphone that counts the takes started on it. A take takes a moment to
 * open, its file made, and a second one is refused, as `VoiceRecorder`'s is.
 */
function makeRecorder() {
	const takes = { started: 0, cancelled: 0 };
	let isRecording = false;
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- a stand-in with only what a take uses.
	const recorder = {
		start: async () => {
			await new Promise((resolve) => setTimeout(resolve, 300));
			if (isRecording) throw new Error("Already recording");
			isRecording = true;
			takes.started += 1;
		},
		cancel: async () => {
			takes.cancelled += 1;
		},
	} as unknown as VoiceRecorder;
	return { recorder, takes };
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- a stand-in with only what a take uses.
const editor = {
	playback: {
		getCurrentTime: () => 0,
		isMuted: () => false,
		mute: () => {},
		play: () => {},
	},
} as unknown as EditorCore;

// The count-in's 3-2-1, a second each, and what's awaited between.
async function advance({ seconds }: { seconds: number }) {
	for (let step = 0; step < seconds * 10; step++) {
		jest.advanceTimersByTime(100);
		await Promise.resolve();
		await Promise.resolve();
	}
}

describe("the count-in", () => {
	beforeEach(() => jest.useFakeTimers());
	afterEach(() => jest.useRealTimers());

	test("cancelled and started again, it records one take", async () => {
		const { recorder, takes } = makeRecorder();
		useRecordingStore.setState({ recorder, status: "ready" });

		const first = startTake({ editor });
		await advance({ seconds: 0.1 });
		cancelCountIn();
		expect(useRecordingStore.getState().status).toBe("ready");
		const second = startTake({ editor });
		await advance({ seconds: 4 });
		await Promise.all([first, second]);

		expect(takes.started).toBe(1);
		expect(useRecordingStore.getState().status).toBe("recording");
	});

	test("a second click while counting does nothing", async () => {
		const { recorder, takes } = makeRecorder();
		useRecordingStore.setState({ recorder, status: "ready" });

		const first = startTake({ editor });
		const second = startTake({ editor });
		await advance({ seconds: 4 });
		await Promise.all([first, second]);

		expect(takes.started).toBe(1);
	});

	test("cancelled, it records nothing", async () => {
		const { recorder, takes } = makeRecorder();
		useRecordingStore.setState({ recorder, status: "ready" });

		const take = startTake({ editor });
		await advance({ seconds: 1.5 });
		cancelCountIn();
		await advance({ seconds: 3 });
		await take;

		expect(takes.started).toBe(0);
		expect(useRecordingStore.getState().status).toBe("ready");
	});
});
