import { describe, expect, test } from "bun:test";
import { findSilences, integratedLoudness, samplePeak } from "../sound";

const RATE = 48_000;

/** `seconds` of a 1 kHz tone of `amplitude`, or of silence. */
function tone({ seconds, amplitude }: { seconds: number; amplitude: number }) {
	return Float32Array.from(
		{ length: Math.round(seconds * RATE) },
		(_, i) => amplitude * Math.sin((2 * Math.PI * 1000 * i) / RATE),
	);
}

function joined({ parts }: { parts: Float32Array[] }): Float32Array {
	const all = new Float32Array(
		parts.reduce((sum, part) => sum + part.length, 0),
	);
	let at = 0;
	for (const part of parts) {
		all.set(part, at);
		at += part.length;
	}
	return all;
}

describe("the sound, measured", () => {
	test("a 1 kHz tone 20 dB under full scale, in both channels, is -20 LUFS", () => {
		const left = tone({ seconds: 3, amplitude: 0.1 });
		const loudness = integratedLoudness({
			channels: [left, left],
			sampleRate: RATE,
		});
		expect(loudness).not.toBeNull();
		expect(Math.abs((loudness ?? 0) + 20)).toBeLessThan(0.05);
		expect(samplePeak({ channels: [left] })).toBeCloseTo(-20, 1);
	});

	test("silence has no loudness", () => {
		const quiet = new Float32Array(RATE * 2);
		expect(
			integratedLoudness({ channels: [quiet], sampleRate: RATE }),
		).toBeNull();
		expect(samplePeak({ channels: [quiet] })).toBeNull();
	});

	test("finds the silences long enough, between the sounds", () => {
		const samples = joined({
			parts: [
				tone({ seconds: 1, amplitude: 0.3 }),
				tone({ seconds: 0.8, amplitude: 0 }),
				tone({ seconds: 1, amplitude: 0.3 }),
				tone({ seconds: 0.2, amplitude: 0 }),
				tone({ seconds: 1, amplitude: 0.3 }),
			],
		});
		const silences = findSilences({
			channels: [samples],
			sampleRate: RATE,
			thresholdDb: -50,
			minSeconds: 0.5,
		});
		expect(silences).toHaveLength(1);
		expect(silences[0].from).toBeCloseTo(1, 1);
		expect(silences[0].to).toBeCloseTo(1.8, 1);
	});
});
