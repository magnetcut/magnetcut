import { describe, expect, test } from "bun:test";
import { mediaTime, TICKS_PER_SECOND } from "@/wasm";
import {
	getThumbnailSize,
	getThumbnailTimes,
	isNearlyBlack,
} from "../thumbnail";

/** A frame of `count` pixels, `bright` of them white and the rest black. */
function frame({ count, bright }: { count: number; bright: number }) {
	const pixels = new Uint8ClampedArray(count * 4);
	for (let i = 0; i < count; i++) {
		const value = i < bright ? 255 : 0;
		pixels.set([value, value, value, 255], i * 4);
	}
	return pixels;
}

describe("a project's thumbnail", () => {
	test("is no larger than 640 pixels, in the canvas's shape", () => {
		expect(getThumbnailSize({ width: 1920, height: 1080 })).toEqual({
			width: 640,
			height: 360,
		});
		expect(getThumbnailSize({ width: 1080, height: 1920 })).toEqual({
			width: 360,
			height: 640,
		});
		expect(getThumbnailSize({ width: 320, height: 240 })).toEqual({
			width: 320,
			height: 240,
		});
	});

	test("is looked for at the start, a few moments in, then further", () => {
		const seconds = (value: number) =>
			mediaTime({ ticks: value * TICKS_PER_SECOND });
		const times = getThumbnailTimes({
			lastFrameTime: seconds(100),
		});
		expect(times).toEqual([0, 0.5, 1.5, 3, 10, 25].map(seconds));
	});

	test("on a short timeline, is looked for no later than its last frame", () => {
		const last = mediaTime({ ticks: TICKS_PER_SECOND });
		const times = getThumbnailTimes({ lastFrameTime: last });
		expect(times.at(-1)).toBe(last);
		expect(new Set(times).size).toBe(times.length);
		expect(times.every((time) => time <= last)).toBe(true);
	});

	test("isn't a frame that's nearly all black", () => {
		expect(isNearlyBlack({ pixels: frame({ count: 1000, bright: 0 }) })).toBe(
			true,
		);
		expect(isNearlyBlack({ pixels: frame({ count: 1000, bright: 5 }) })).toBe(
			true,
		);
		// A title in white on black.
		expect(isNearlyBlack({ pixels: frame({ count: 1000, bright: 30 }) })).toBe(
			false,
		);
	});
});
