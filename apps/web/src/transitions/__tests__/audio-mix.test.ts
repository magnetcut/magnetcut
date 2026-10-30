import { describe, expect, test } from "bun:test";
import { type CollectedAudioElement, mixAudioChannels } from "@/media/audio";
import type { VideoElement } from "@/timeline";
import type { AudioCrossfade } from "@/transitions";
import { mediaTime } from "@/wasm";

// Few samples a second keep the arithmetic readable.
const RATE = 100;

class TestAudioBuffer implements AudioBuffer {
	readonly sampleRate = RATE;
	readonly numberOfChannels = 2;
	private channels: Float32Array<ArrayBuffer>[];

	constructor({ length, value }: { length: number; value: number }) {
		this.channels = [0, 1].map(() => new Float32Array(length).fill(value));
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

const element: VideoElement = {
	id: "a",
	type: "video",
	name: "a",
	mediaId: "clip",
	startTime: mediaTime({ ticks: 0 }),
	duration: mediaTime({ ticks: 0 }),
	trimStart: mediaTime({ ticks: 0 }),
	trimEnd: mediaTime({ ticks: 0 }),
	params: {},
};

/** The output after mixing in one clip of constant 1s. */
function mix({
	startTime,
	duration,
	crossfade,
}: {
	startTime: number;
	duration: number;
	crossfade: AudioCrossfade;
}): Float32Array {
	// Ten seconds of source, so the handles have audio in them.
	const buffer = new TestAudioBuffer({ length: 10 * RATE, value: 1 });
	const outputBuffer = new TestAudioBuffer({ length: 10 * RATE, value: 0 });
	const collected: CollectedAudioElement = {
		timelineElement: element,
		buffer,
		startTime,
		duration,
		trimStart: 2,
		trimEnd: 2,
		volume: 1,
		muted: false,
		crossfade,
	};
	mixAudioChannels({
		element: collected,
		buffer,
		trimStart: 2,
		outputBuffer,
		outputLength: outputBuffer.length,
		sampleRate: RATE,
	});
	return outputBuffer.getChannelData(0);
}

const at = ({ samples, time }: { samples: Float32Array; time: number }) =>
	samples[Math.round(time * RATE)];

describe("the export mix across a crossfade", () => {
	// A 1 s window centred on a cut at 4 s.
	const window = { start: 3.5, end: 4.5 };

	test("the outgoing clip fades out, past its end into its tail", () => {
		const samples = mix({
			startTime: 0,
			duration: 4.5,
			crossfade: { head: 0, tail: 0.5, fadeOut: window },
		});
		expect(at({ samples, time: 3 })).toBeCloseTo(1);
		expect(at({ samples, time: 3.5 })).toBeCloseTo(1);
		expect(at({ samples, time: 4 })).toBeCloseTo(Math.SQRT1_2);
		expect(at({ samples, time: 4.25 })).toBeGreaterThan(0);
		expect(at({ samples, time: 4.6 })).toBe(0);
	});

	test("the incoming clip fades in, from its head before its start", () => {
		const samples = mix({
			startTime: 3.5,
			duration: 4.5,
			crossfade: { head: 0.5, tail: 0, fadeIn: window },
		});
		expect(at({ samples, time: 3.4 })).toBe(0);
		expect(at({ samples, time: 3.5 })).toBeCloseTo(0);
		expect(at({ samples, time: 3.75 })).toBeGreaterThan(0);
		expect(at({ samples, time: 4 })).toBeCloseTo(Math.SQRT1_2);
		expect(at({ samples, time: 4.5 })).toBeCloseTo(1);
		expect(at({ samples, time: 6 })).toBeCloseTo(1);
	});
});
