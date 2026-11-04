import { describe, expect, test } from "bun:test";
import { mixAudioChannels } from "@/media/audio";
import type { AudioElement } from "@/timeline";
import { mediaTime, TICKS_PER_SECOND } from "@/wasm";
import {
	FADE_SILENCE_DB,
	getFadeGain,
	getFadeTimes,
	readClipFades,
} from "../audio-fades";

function makeElement({
	seconds,
	params,
}: {
	seconds: number;
	params: Record<string, number>;
}): AudioElement {
	return {
		id: "a",
		type: "audio",
		name: "a",
		sourceType: "upload",
		mediaId: "clip",
		startTime: mediaTime({ ticks: 0 }),
		duration: mediaTime({ ticks: seconds * TICKS_PER_SECOND }),
		trimStart: mediaTime({ ticks: 0 }),
		trimEnd: mediaTime({ ticks: 0 }),
		params,
	};
}

describe("readClipFades", () => {
	test("is null without fades", () => {
		expect(
			readClipFades({ element: makeElement({ seconds: 10, params: {} }) }),
		).toBeNull();
		expect(
			readClipFades({
				element: makeElement({
					seconds: 10,
					params: { fadeIn: 0, fadeOut: 0 },
				}),
			}),
		).toBeNull();
	});

	test("shortens fades that would overlap alike, to meet", () => {
		const fades = readClipFades({
			element: makeElement({ seconds: 3, params: { fadeIn: 4, fadeOut: 2 } }),
		});
		expect(fades?.in).toBeCloseTo(2);
		expect(fades?.out).toBeCloseTo(1);
	});

	test("leaves out a fade at an end a transition crossfades", () => {
		const element = makeElement({
			seconds: 10,
			params: { fadeIn: 1, fadeOut: 1 },
		});
		const window = { start: 9, end: 10 };
		expect(
			readClipFades({
				element,
				crossfade: { head: 0, tail: 0, fadeOut: window },
			})?.out,
		).toBe(0);
		expect(
			readClipFades({
				element,
				crossfade: { head: 0, tail: 0, fadeIn: window, fadeOut: window },
			}),
		).toBeNull();
	});

	test("reads silence as no floor, a level as its gain", () => {
		const fades = readClipFades({
			element: makeElement({
				seconds: 10,
				params: { fadeIn: 1, fadeInLevel: FADE_SILENCE_DB, fadeOutLevel: -6 },
			}),
		});
		expect(fades?.inFloor).toBe(0);
		expect(fades?.outFloor).toBeCloseTo(10 ** (-6 / 20));
	});
});

describe("getFadeGain", () => {
	const fades = readClipFades({
		element: makeElement({ seconds: 10, params: { fadeIn: 2, fadeOut: 4 } }),
	});

	test("rises from silence over the fade in, equal power", () => {
		expect(getFadeGain({ fades, clipTime: 0 })).toBe(0);
		expect(getFadeGain({ fades, clipTime: 1 })).toBeCloseTo(Math.SQRT1_2);
		expect(getFadeGain({ fades, clipTime: 2 })).toBe(1);
		expect(getFadeGain({ fades, clipTime: 5 })).toBe(1);
	});

	test("falls to silence over the fade out", () => {
		expect(getFadeGain({ fades, clipTime: 6 })).toBeCloseTo(1);
		expect(getFadeGain({ fades, clipTime: 8 })).toBeCloseTo(Math.SQRT1_2);
		expect(getFadeGain({ fades, clipTime: 10 })).toBeCloseTo(0);
	});

	test("starts from its level, not silence, when given one", () => {
		const partial = readClipFades({
			element: makeElement({
				seconds: 10,
				params: { fadeIn: 2, fadeInLevel: -6 },
			}),
		});
		expect(getFadeGain({ fades: partial, clipTime: 0 })).toBeCloseTo(
			10 ** (-6 / 20),
		);
		expect(getFadeGain({ fades: partial, clipTime: 2 })).toBe(1);
	});

	test("is one without fades", () => {
		expect(getFadeGain({ fades: null, clipTime: 0 })).toBe(1);
	});
});

test("getFadeTimes steps through the fades within the range", () => {
	const fades = readClipFades({
		element: makeElement({ seconds: 10, params: { fadeIn: 1, fadeOut: 1 } }),
	});
	if (!fades) throw new Error("no fades");
	const times = getFadeTimes({ fades, from: 0.5, to: 10, step: 0.25 });
	expect(times).toEqual([0.5, 0.75, 1, 9, 9.25, 9.5, 9.75, 10]);
});

/** Constant sound, at few samples a second. */
class TestAudioBuffer implements AudioBuffer {
	readonly sampleRate = 100;
	readonly numberOfChannels = 2;
	readonly channels: Float32Array<ArrayBuffer>[];

	constructor({ seconds, value }: { seconds: number; value: number }) {
		this.channels = [0, 1].map(() =>
			new Float32Array(seconds * this.sampleRate).fill(value),
		);
	}

	get length() {
		return this.channels[0].length;
	}

	get duration() {
		return this.length / this.sampleRate;
	}

	getChannelData(channel: number): Float32Array<ArrayBuffer> {
		return this.channels[channel];
	}

	// eslint-disable-next-line magnetcut/prefer-object-params -- AudioBuffer's own signature
	copyFromChannel(destination: Float32Array<ArrayBuffer>, channel: number) {
		destination.set(this.channels[channel].subarray(0, destination.length));
	}

	// eslint-disable-next-line magnetcut/prefer-object-params -- AudioBuffer's own signature
	copyToChannel(source: Float32Array<ArrayBuffer>, channel: number) {
		this.channels[channel].set(source);
	}
}

test("the export's mix fades the clip in and out", () => {
	const buffer = new TestAudioBuffer({ seconds: 10, value: 1 });
	const output = new TestAudioBuffer({ seconds: 4, value: 0 });
	const element = makeElement({
		seconds: 4,
		params: { fadeIn: 1, fadeOut: 2 },
	});
	mixAudioChannels({
		element: {
			timelineElement: element,
			startTime: 0,
			duration: 4,
			trimStart: 0,
			trimEnd: 0,
			volume: 1,
		},
		buffer,
		trimStart: 0,
		outputBuffer: output,
		outputLength: output.length,
		sampleRate: output.sampleRate,
	});
	const left = output.getChannelData(0);
	expect(left[0]).toBe(0);
	expect(left[50]).toBeCloseTo(Math.SQRT1_2);
	expect(left[150]).toBeCloseTo(1);
	expect(left[300]).toBeCloseTo(Math.SQRT1_2);
	expect(left[399]).toBeLessThan(0.01);
});
