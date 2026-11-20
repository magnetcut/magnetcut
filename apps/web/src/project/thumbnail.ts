import { roundMediaTime, TICKS_PER_SECOND, type MediaTime } from "@/wasm";

/*
 * A project's thumbnail, on the projects page: the first frame on its
 * timeline that isn't black, as many videos fade in from it.
 */

/** Its longer side, in pixels: the projects page shows it about 330 wide. */
export const THUMBNAIL_MAX_SIZE = 640;

export const THUMBNAIL_TYPE = "image/jpeg";
export const THUMBNAIL_QUALITY = 0.85;

/** A pixel at least this bright, out of 255, isn't black. */
const BRIGHT_LUMA = 32;
/** A frame with a smaller share of bright pixels is nearly black: a title in
 * white on black has more. */
const BRIGHT_SHARE = 0.01;

/** Its size for a canvas of this size: the same shape, no larger. */
export function getThumbnailSize({
	width,
	height,
}: {
	width: number;
	height: number;
}): { width: number; height: number } {
	const scale = Math.min(1, THUMBNAIL_MAX_SIZE / Math.max(width, height));
	return {
		width: Math.max(1, Math.round(width * scale)),
		height: Math.max(1, Math.round(height * scale)),
	};
}

/**
 * Where on the timeline to look for it, in order: the start, a few moments
 * in, then a tenth and a quarter of the way through.
 */
export function getThumbnailTimes({
	lastFrameTime,
}: {
	lastFrameTime: MediaTime;
}): MediaTime[] {
	const candidates = [
		0,
		0.5 * TICKS_PER_SECOND,
		1.5 * TICKS_PER_SECOND,
		3 * TICKS_PER_SECOND,
		lastFrameTime * 0.1,
		lastFrameTime * 0.25,
	];
	const times = new Set(
		candidates.map((time) =>
			roundMediaTime({ time: Math.min(time, lastFrameTime) }),
		),
	);
	return [...times].sort((a, b) => a - b);
}

/** Whether a frame's pixels (RGBA) are nearly all black. */
export function isNearlyBlack({
	pixels,
}: {
	pixels: Uint8ClampedArray;
}): boolean {
	let bright = 0;
	for (let i = 0; i + 2 < pixels.length; i += 4) {
		// Rec. 709 luma, near enough.
		const luma =
			0.2126 * (pixels[i] ?? 0) +
			0.7152 * (pixels[i + 1] ?? 0) +
			0.0722 * (pixels[i + 2] ?? 0);
		if (luma >= BRIGHT_LUMA) bright++;
	}
	return bright < (pixels.length / 4) * BRIGHT_SHARE;
}
