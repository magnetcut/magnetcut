import { describe, expect, test } from "bun:test";
import {
	buildWavHeader,
	floatsToPcm16,
	readWavDuration,
	WAV_HEADER_BYTES,
} from "../wav";

function joinBytes({ parts }: { parts: Uint8Array[] }): ArrayBuffer {
	const total = parts.reduce((sum, part) => sum + part.length, 0);
	const joined = new Uint8Array(total);
	let at = 0;
	for (const part of parts) {
		joined.set(part, at);
		at += part.length;
	}
	return joined.buffer;
}

describe("WAV files", () => {
	test("the header says what follows it", () => {
		const header = buildWavHeader({
			sampleRate: 48000,
			channels: 1,
			dataBytes: 96000,
		});
		const view = new DataView(header.buffer);
		expect(header.length).toBe(WAV_HEADER_BYTES);
		expect(String.fromCharCode(...header.slice(0, 4))).toBe("RIFF");
		expect(view.getUint32(4, true)).toBe(36 + 96000);
		expect(view.getUint16(22, true)).toBe(1);
		expect(view.getUint32(24, true)).toBe(48000);
		expect(view.getUint32(28, true)).toBe(96000);
		expect(view.getUint32(40, true)).toBe(96000);
	});

	test("samples become 16-bit, clipped, the channels interleaved", () => {
		const bytes = floatsToPcm16({
			channels: [new Float32Array([1, -1, 2]), new Float32Array([0, 0.5, -2])],
		});
		const view = new DataView(bytes.buffer);
		expect(bytes.length).toBe(12);
		expect(
			Array.from({ length: 6 }, (_, index) => view.getInt16(index * 2, true)),
		).toEqual([32767, 0, -32768, 16384, 32767, -32768]);
	});

	test("a file's length comes from its header, or from its size while it's written", () => {
		const samples = floatsToPcm16({ channels: [new Float32Array(24000)] });
		const whole = joinBytes({
			parts: [
				buildWavHeader({
					sampleRate: 48000,
					channels: 1,
					dataBytes: samples.length,
				}),
				samples,
			],
		});
		expect(readWavDuration({ bytes: whole })).toBe(0.5);
		const unfilled = joinBytes({
			parts: [
				buildWavHeader({ sampleRate: 48000, channels: 1, dataBytes: 0 }),
				samples,
			],
		});
		expect(readWavDuration({ bytes: unfilled })).toBe(0.5);
		expect(readWavDuration({ bytes: new ArrayBuffer(8) })).toBeNull();
	});
});
