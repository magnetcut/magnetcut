import { describe, expect, test } from "bun:test";
import { findFrameBars, mergeBlackBars, type PixelFrame } from "../black-bars";
import { NO_CROP, fitExportSize, getCroppedSize } from "../settings";

/** A frame of `width` by `height`, grey where `isPicture` says, black (with some noise) elsewhere. */
function makeFrame({
	width,
	height,
	isPicture,
	noise = 0,
}: {
	width: number;
	height: number;
	isPicture: ({ x, y }: { x: number; y: number }) => boolean;
	noise?: number;
}): PixelFrame {
	const data = new Uint8ClampedArray(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const value = isPicture({ x, y }) ? 128 : (x * 7 + y * 13) % (noise + 1);
			data.set([value, value, value, 255], (y * width + x) * 4);
		}
	}
	return { width, height, data };
}

describe("findFrameBars", () => {
	test("finds letterbox bars", () => {
		const frame = makeFrame({
			width: 64,
			height: 36,
			isPicture: ({ y }) => y >= 5 && y < 31,
		});
		expect(findFrameBars({ frame })).toEqual({
			top: 5,
			bottom: 5,
			left: 0,
			right: 0,
		});
	});

	test("finds pillarbox bars under letterbox bars, in a noisy black", () => {
		const frame = makeFrame({
			width: 64,
			height: 36,
			isPicture: ({ x, y }) => x >= 8 && x < 60 && y >= 3 && y < 36,
			noise: 20,
		});
		expect(findFrameBars({ frame })).toEqual({
			top: 3,
			bottom: 0,
			left: 8,
			right: 4,
		});
	});

	test("keeps a dark line with something bright in it", () => {
		const frame = makeFrame({
			width: 64,
			height: 36,
			isPicture: ({ x, y }) => y > 0 || x === 30,
		});
		expect(findFrameBars({ frame })?.top).toBe(0);
	});

	test("says nothing of a black frame", () => {
		const frame = makeFrame({ width: 16, height: 16, isPicture: () => false });
		expect(findFrameBars({ frame })).toBeNull();
	});
});

describe("mergeBlackBars", () => {
	test("crops only what's black in every frame, in even numbers", () => {
		const crop = mergeBlackBars({
			bars: [
				{ top: 141, bottom: 140, left: 0, right: 3 },
				null,
				{ top: 139, bottom: 144, left: 2, right: 3 },
			],
			width: 1920,
			height: 1080,
		});
		expect(crop).toEqual({ top: 138, bottom: 140, left: 0, right: 2 });
	});

	test("crops nothing when the bars would take most of the picture", () => {
		expect(
			mergeBlackBars({
				bars: [{ top: 500, bottom: 400, left: 0, right: 0 }],
				width: 1920,
				height: 1080,
			}),
		).toEqual(NO_CROP);
		expect(
			mergeBlackBars({ bars: [null, null], width: 16, height: 16 }),
		).toEqual(NO_CROP);
	});
});

describe("a cropped export's size", () => {
	test("is the picture left, scaled by its shorter side", () => {
		const canvas = { width: 1920, height: 1080 };
		const crop = { top: 140, bottom: 140, left: 0, right: 0 };
		expect(getCroppedSize({ canvas, crop })).toEqual({
			width: 1920,
			height: 800,
		});
		expect(fitExportSize({ canvas, crop })).toEqual({
			width: 1920,
			height: 800,
		});
		expect(fitExportSize({ canvas, crop, shortSide: 400 })).toEqual({
			width: 960,
			height: 400,
		});
	});
});
