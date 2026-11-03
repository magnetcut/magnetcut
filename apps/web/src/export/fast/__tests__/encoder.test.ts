import { describe, expect, test } from "bun:test";
import { getEncoderCodecs, makeRangeTables, toBytes } from "../encoder";

describe("getEncoderCodecs", () => {
	test("the source's codec first, at its level", () => {
		expect(
			getEncoderCodecs({
				codec: "avc",
				sourceCodec: "avc1.64001f",
				isWebKit: false,
			}),
		).toEqual([
			"avc1.64001f",
			"avc1.4d001f",
			"avc1.42001f",
			"avc1.640033",
			"avc1.420033",
		]);
	});

	test("Baseline first in WebKit, whose encoder makes nothing in the others", () => {
		expect(
			getEncoderCodecs({
				codec: "avc",
				sourceCodec: "avc1.64001f",
				isWebKit: true,
			}),
		).toEqual(["avc1.42001f", "avc1.420033", "avc1.64001f", "avc1.4d001f"]);
	});

	test("VP9: the source's, then profile 0", () => {
		expect(
			getEncoderCodecs({
				codec: "vp9",
				sourceCodec: "vp09.00.31.08",
				isWebKit: false,
			}),
		).toEqual(["vp09.00.31.08", "vp09.00.40.08", "vp09.00.10.08"]);
	});
});

describe("makeRangeTables", () => {
	test("8 bits: full range into limited, and back", () => {
		const limited = makeRangeTables({ depth: 8, toFull: false });
		expect([limited.luma[0], limited.luma[255]]).toEqual([16, 235]);
		expect([
			limited.chroma[0],
			limited.chroma[128],
			limited.chroma[255],
		]).toEqual([16, 128, 240]);

		const full = makeRangeTables({ depth: 8, toFull: true });
		expect([full.luma[16], full.luma[235]]).toEqual([0, 255]);
		// Past the limits, clamped.
		expect([full.luma[0], full.luma[255]]).toEqual([0, 255]);
		expect([full.chroma[128], full.chroma[240]]).toEqual([128, 255]);

		// Into full range and back gives every limited value as it was.
		for (let value = 16; value <= 235; value++) {
			expect(limited.luma[full.luma[value]]).toBe(value);
		}
		for (let value = 16; value <= 240; value++) {
			expect(limited.chroma[full.chroma[value]]).toBe(value);
		}
	});

	test("10 bits: the limits four times as far", () => {
		const limited = makeRangeTables({ depth: 10, toFull: false });
		expect([limited.luma[0], limited.luma[1023]]).toEqual([64, 940]);
		expect([
			limited.chroma[0],
			limited.chroma[512],
			limited.chroma[1023],
		]).toEqual([64, 512, 960]);
	});
});

test("toBytes reads a view as the bytes it covers", () => {
	const buffer = Uint8Array.of(1, 2, 3, 4, 5).buffer;
	expect([...toBytes({ source: new Uint8Array(buffer, 1, 3) })]).toEqual([
		2, 3, 4,
	]);
	expect([...toBytes({ source: new DataView(buffer, 3) })]).toEqual([4, 5]);
	expect([...toBytes({ source: buffer })]).toEqual([1, 2, 3, 4, 5]);
});
