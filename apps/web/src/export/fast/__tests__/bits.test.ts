import { describe, expect, test } from "bun:test";
import {
	BitReader,
	BitWriter,
	escapeRbsp,
	findStopBit,
	unescapeRbsp,
} from "../bits";

/** The bits of `data` from `from` to `to`, as a string of 0s and 1s. */
function bitsOf({
	data,
	from = 0,
	to = data.length * 8,
}: {
	data: Uint8Array;
	from?: number;
	to?: number;
}): string {
	let out = "";
	for (let position = from; position < to; position++) {
		out += (data[position >> 3] >> (7 - (position & 7))) & 1;
	}
	return out;
}

/** Whether a NAL unit's payload holds what a decoder would take for a start code. */
function hasStartCode({ payload }: { payload: Uint8Array }): boolean {
	for (let i = 2; i < payload.length; i++) {
		if (payload[i - 2] === 0 && payload[i - 1] === 0 && payload[i] <= 2) {
			return true;
		}
	}
	return false;
}

/** Bytes from a seed, a lot of them zeros, as video has. */
function makeBytes({
	seed,
	length,
}: {
	seed: number;
	length: number;
}): Uint8Array {
	let state = seed;
	const next = () => {
		state = (state * 1103515245 + 12345) % 2 ** 31;
		return state;
	};
	return Uint8Array.from({ length }, () => (next() % 3 === 0 ? next() % 4 : 0));
}

describe("emulation prevention", () => {
	test("takes out the 3 after two zeros, and puts it back", () => {
		expect([
			...unescapeRbsp({ nal: Uint8Array.of(1, 0, 0, 3, 1, 0, 0, 3, 0) }),
		]).toEqual([1, 0, 0, 1, 0, 0, 0]);
		expect([
			...escapeRbsp({ rbsp: Uint8Array.of(1, 0, 0, 1, 0, 0, 0) }),
		]).toEqual([1, 0, 0, 3, 1, 0, 0, 3, 0, 3]);
	});

	test("a payload ending in a zero gets a 3 after it", () => {
		expect([...escapeRbsp({ rbsp: Uint8Array.of(5, 0) })]).toEqual([5, 0, 3]);
		expect([...escapeRbsp({ rbsp: Uint8Array.of(0, 0) })]).toEqual([0, 0, 3]);
	});

	test("round trips, and never leaves a start code in", () => {
		for (let seed = 1; seed <= 50; seed++) {
			const rbsp = makeBytes({ seed, length: 200 });
			const payload = escapeRbsp({ rbsp });
			expect(hasStartCode({ payload })).toBe(false);
			expect(payload.at(-1)).not.toBe(0);
			expect([...unescapeRbsp({ nal: payload })].slice(0, rbsp.length)).toEqual(
				[...rbsp],
			);
		}
	});
});

describe("findStopBit", () => {
	test("is the last bit set", () => {
		expect(findStopBit({ rbsp: Uint8Array.of(0x80) })).toBe(0);
		expect(findStopBit({ rbsp: Uint8Array.of(0x01) })).toBe(7);
		expect(findStopBit({ rbsp: Uint8Array.of(0x12, 0x40, 0x00) })).toBe(9);
	});

	test("throws when there's none", () => {
		expect(() => findStopBit({ rbsp: Uint8Array.of(0, 0) })).toThrow();
	});
});

describe("Exp-Golomb codes", () => {
	test("read back what's written", () => {
		const writer = new BitWriter();
		const values = [0, 1, 2, 3, 7, 8, 30, 31, 255, 256, 1000, 65535];
		for (const value of values) writer.ue({ value });
		const reader = new BitReader({ data: writer.finish() });
		expect(values.map(() => reader.ue())).toEqual(values);
	});

	test("are the codes of the standard", () => {
		const writer = new BitWriter();
		for (const value of [0, 1, 2, 3]) writer.ue({ value });
		// 1, 010, 011, 00100, then the stop bit and zeros.
		expect(bitsOf({ data: writer.finish() })).toBe("1010011001001000");
	});

	test("se(v) alternates sign", () => {
		const writer = new BitWriter();
		for (const value of [0, 1, 2, 3, 4]) writer.ue({ value });
		const reader = new BitReader({ data: writer.finish() });
		expect([0, 1, 2, 3, 4].map(() => reader.se())).toEqual([0, 1, -1, 2, -2]);
	});
});

describe("BitWriter.copy", () => {
	const data = makeBytes({ seed: 7, length: 64 }).map(
		(byte, i) => byte ^ (i * 37),
	);

	test("copies any run of bits after any number already written", () => {
		for (let already = 0; already < 8; already++) {
			for (const [from, to] of [
				[0, 512],
				[3, 500],
				[8, 16],
				[13, 14],
				[5, 5],
				[17, 300],
			]) {
				const writer = new BitWriter();
				writer.bits({ value: 0b1011011, count: already });
				writer.copy({ data, from, to });
				// bits() writes the value's last `count` bits.
				const expected =
					"1011011".slice(7 - already) + bitsOf({ data, from, to });
				expect(writer.bitLength).toBe(already + to - from);
				expect(
					bitsOf({ data: writer.finish() }).slice(0, expected.length),
				).toBe(expected);
			}
		}
	});

	test("finish adds the stop bit and pads to a byte", () => {
		const writer = new BitWriter();
		writer.bits({ value: 0b101, count: 3 });
		expect(bitsOf({ data: writer.finish() })).toBe("10110000");
	});

	test("bytes and take need a byte boundary", () => {
		const writer = new BitWriter();
		writer.bit({ value: 1 });
		expect(() => writer.bytes({ data: Uint8Array.of(1) })).toThrow();
		expect(() => writer.take()).toThrow();
		for (let i = 0; i < 7; i++) writer.bit({ value: 0 });
		writer.bytes({ data: Uint8Array.of(0xab) });
		expect([...writer.take()]).toEqual([0x80, 0xab]);
	});
});
