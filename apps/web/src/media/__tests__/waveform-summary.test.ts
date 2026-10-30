import { describe, expect, test } from "bun:test";
import {
	buildSourceWaveformSummary,
	WaveformSummaryBuilder,
} from "../waveform-summary";

class TestAudioBuffer implements AudioBuffer {
	readonly sampleRate = 48000;
	private readonly channels: Float32Array<ArrayBuffer>[];

	constructor({ channels }: { channels: number[][] }) {
		this.channels = channels.map((samples) => Float32Array.from(samples));
	}

	get numberOfChannels() {
		return this.channels.length;
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

describe("a waveform built a buffer at a time", () => {
	const left = Array.from({ length: 1000 }, (_, i) => Math.sin(i / 7) * 0.8);
	const right = Array.from({ length: 1000 }, (_, i) => Math.cos(i / 11) * 0.5);

	test("has the buckets of the audio taken whole", () => {
		const whole = buildSourceWaveformSummary({
			sourceKey: "a",
			buffer: new TestAudioBuffer({ channels: [left, right] }),
			bucketSize: 64,
		});
		const builder = new WaveformSummaryBuilder({ bucketSize: 64 });
		// Pieces that don't line up with the buckets.
		for (const [start, end] of [
			[0, 100],
			[100, 101],
			[101, 640],
			[640, 1000],
		]) {
			builder.add({
				buffer: new TestAudioBuffer({
					channels: [left.slice(start, end), right.slice(start, end)],
				}),
			});
		}
		expect(builder.build({ sourceKey: "a" })).toEqual(whole);
	});

	test("of nothing is one silent bucket", () => {
		const summary = new WaveformSummaryBuilder().build({ sourceKey: "a" });
		expect([...summary.amplitudes]).toEqual([0]);
		expect(summary.totalSamples).toBe(0);
	});
});
