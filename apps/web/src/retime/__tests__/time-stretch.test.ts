import { describe, expect, test } from "bun:test";
import { timeStretch } from "magnetcut-wasm";

const SAMPLE_RATE = 48_000;

function sine({
	frequency,
	seconds,
}: {
	frequency: number;
	seconds: number;
}): Float32Array {
	const samples = new Float32Array(Math.round(SAMPLE_RATE * seconds));
	for (let i = 0; i < samples.length; i++) {
		samples[i] = Math.sin((2 * Math.PI * frequency * i) / SAMPLE_RATE) * 0.5;
	}
	return samples;
}

// From the rising zero crossings, away from the edges.
function frequencyOf({ samples }: { samples: Float32Array }): number {
	const inner = samples.subarray(
		samples.length / 10,
		(samples.length * 9) / 10,
	);
	let crossings = 0;
	for (let i = 1; i < inner.length; i++) {
		if (inner[i - 1] < 0 && inner[i] >= 0) crossings++;
	}
	return (crossings * SAMPLE_RATE) / inner.length;
}

describe("timeStretch", () => {
	test("changes the length, not the pitch", () => {
		const input = sine({ frequency: 440, seconds: 1 });
		const outputLength = Math.round(input.length / 1.5);
		const [output] = timeStretch({
			channels: [input],
			sampleRate: SAMPLE_RATE,
			tempo: 1.5,
			outputLength,
		});
		expect(output).toBeInstanceOf(Float32Array);
		expect(output.length).toBe(outputLength);
		expect(Math.abs(frequencyOf({ samples: output }) - 440)).toBeLessThan(5);
	});

	test("returns a channel for each one given", () => {
		const left = sine({ frequency: 440, seconds: 0.5 });
		const right = sine({ frequency: 660, seconds: 0.5 });
		const output = timeStretch({
			channels: [left, right],
			sampleRate: SAMPLE_RATE,
			tempo: 0.8,
			outputLength: 30_000,
		});
		expect(output).toHaveLength(2);
		expect(output.every((channel) => channel.length === 30_000)).toBe(true);
	});
});
