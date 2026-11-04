import { describe, expect, test } from "bun:test";
import { canWriteColour, resolveVideoColour, rgbaToI420 } from "../yuv";

const BT709 = {
	primaries: "bt709",
	transfer: "bt709",
	matrix: "bt709",
	fullRange: false,
} as const;

/** A picture of one colour, as RGBA. */
const fill = ({
	rgb,
	width,
	height,
}: {
	rgb: [number, number, number];
	width: number;
	height: number;
}) => {
	const rgba = new Uint8ClampedArray(width * height * 4);
	for (let p = 0; p < rgba.length; p += 4) rgba.set([...rgb, 255], p);
	return rgba;
};

/** Y, U and V of a 2×2 picture of one colour. */
const convert = ({
	rgb,
	colour,
}: {
	rgb: [number, number, number];
	colour: VideoColorSpaceInit;
}) => {
	const yuv = rgbaToI420({
		rgba: fill({ rgb, width: 2, height: 2 }),
		width: 2,
		height: 2,
		colour,
	});
	return [yuv[0], yuv[4], yuv[5]];
};

describe("RGB to I420", () => {
	test("puts black, white and grey in limited range", () => {
		expect(convert({ rgb: [0, 0, 0], colour: BT709 })).toEqual([16, 128, 128]);
		expect(convert({ rgb: [255, 255, 255], colour: BT709 })).toEqual([
			235, 128, 128,
		]);
		expect(convert({ rgb: [128, 128, 128], colour: BT709 })).toEqual([
			126, 128, 128,
		]);
	});

	test("puts them in full range when the colour is", () => {
		const full = { ...BT709, fullRange: true };
		expect(convert({ rgb: [0, 0, 0], colour: full })).toEqual([0, 128, 128]);
		expect(convert({ rgb: [255, 255, 255], colour: full })).toEqual([
			255, 128, 128,
		]);
	});

	test("weighs red by the matrix", () => {
		expect(convert({ rgb: [255, 0, 0], colour: BT709 })).toEqual([
			63, 102, 240,
		]);
		const bt601 = { ...BT709, matrix: "smpte170m" } as const;
		expect(convert({ rgb: [255, 0, 0], colour: bt601 })).toEqual([81, 90, 240]);
	});

	test("averages the pixels each chroma sample covers, odd sizes too", () => {
		// 3×1: black and white share the first chroma sample, red has its own.
		const rgba = new Uint8ClampedArray([
			0, 0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 255,
		]);
		const yuv = rgbaToI420({ rgba, width: 3, height: 1, colour: BT709 });
		expect(yuv.length).toBe(3 + 2 + 2);
		expect([...yuv.subarray(0, 3)]).toEqual([16, 235, 63]);
		expect([...yuv.subarray(3)]).toEqual([128, 102, 128, 240]);
	});
});

describe("a video's colour", () => {
	test("is BT.709, limited, where unsaid, at any size", () => {
		const unsaid = {
			primaries: null,
			transfer: null,
			matrix: null,
			fullRange: null,
		};
		expect(resolveVideoColour({ colour: unsaid })).toEqual(BT709);
		expect(resolveVideoColour({ colour: null })).toEqual(BT709);
	});

	test("keeps what the file says", () => {
		const said = { ...BT709, fullRange: true };
		const bt601 = { ...BT709, matrix: "smpte170m" } as const;
		expect(resolveVideoColour({ colour: said })).toEqual(said);
		expect(resolveVideoColour({ colour: bt601 })).toEqual(bt601);
	});

	test("can be written unless it's HDR or its matrix is unknown", () => {
		expect(canWriteColour({ colour: BT709 })).toBe(true);
		expect(canWriteColour({ colour: { ...BT709, transfer: "pq" } })).toBe(
			false,
		);
		expect(canWriteColour({ colour: { ...BT709, matrix: "rgb" } })).toBe(false);
	});
});
