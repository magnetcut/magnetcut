import { NO_CROP, type ExportCrop } from "./settings";

// Black bars found in rendered frames, for Export's crop: rows and columns
// along the edges that are black in every frame that has a picture.

/** A frame's pixels, RGBA, as `getImageData` gives them. */
export interface PixelFrame {
	width: number;
	height: number;
	data: Uint8ClampedArray;
}

// A line is black if it's dark on average and nowhere much brighter, which
// allows for the noise a compressed source has in its black.
const BLACK_MEAN = 24;
const BLACK_MAX = 64;
// Bars this large are a picture that's mostly dark, not bars.
const MAX_CROP_FRACTION = 0.4;

function getLuma({ data, index }: { data: Uint8ClampedArray; index: number }) {
	return (data[index] * 54 + data[index + 1] * 183 + data[index + 2] * 19) >> 8;
}

function countEdge({
	isBlack,
	length,
	fromEnd,
}: {
	isBlack: (index: number) => boolean;
	length: number;
	fromEnd: boolean;
}): number {
	let count = 0;
	while (count < length && isBlack(fromEnd ? length - 1 - count : count)) {
		count++;
	}
	return count;
}

/** The black bars of one frame; none if the whole frame is black. */
export function findFrameBars({
	frame,
}: {
	frame: PixelFrame;
}): ExportCrop | null {
	const { width, height, data } = frame;
	const isLineBlack = ({
		sum,
		max,
		length,
	}: {
		sum: number;
		max: number;
		length: number;
	}) => sum / length <= BLACK_MEAN && max <= BLACK_MAX;

	const isRowBlack = (y: number) => {
		let sum = 0;
		let max = 0;
		for (let x = 0; x < width; x++) {
			const luma = getLuma({ data, index: (y * width + x) * 4 });
			sum += luma;
			if (luma > max) max = luma;
		}
		return isLineBlack({ sum, max, length: width });
	};
	const top = countEdge({
		isBlack: isRowBlack,
		length: height,
		fromEnd: false,
	});
	if (top === height) return null;
	const bottom = countEdge({
		isBlack: isRowBlack,
		length: height,
		fromEnd: true,
	});

	// Columns only where the picture is, so the bars above and below don't
	// darken them.
	const isColumnBlack = (x: number) => {
		let sum = 0;
		let max = 0;
		for (let y = top; y < height - bottom; y++) {
			const luma = getLuma({ data, index: (y * width + x) * 4 });
			sum += luma;
			if (luma > max) max = luma;
		}
		return isLineBlack({ sum, max, length: height - bottom - top });
	};
	const left = countEdge({
		isBlack: isColumnBlack,
		length: width,
		fromEnd: false,
	});
	const right = countEdge({
		isBlack: isColumnBlack,
		length: width,
		fromEnd: true,
	});
	return { top, bottom, left, right };
}

/**
 * The bars of a film from those of its frames: only what's black in all of
 * them, in even numbers, and none at all if they'd take most of the picture.
 */
export function mergeBlackBars({
	bars,
	width,
	height,
}: {
	bars: (ExportCrop | null)[];
	width: number;
	height: number;
}): ExportCrop {
	const pictures = bars.filter((bar) => bar !== null);
	if (pictures.length === 0) return NO_CROP;
	const least = (side: keyof ExportCrop) =>
		2 * Math.floor(Math.min(...pictures.map((bar) => bar[side])) / 2);
	const crop = {
		top: least("top"),
		bottom: least("bottom"),
		left: least("left"),
		right: least("right"),
	};
	const isTooMuch =
		crop.top + crop.bottom > height * MAX_CROP_FRACTION * 2 ||
		crop.left + crop.right > width * MAX_CROP_FRACTION * 2;
	return isTooMuch ? NO_CROP : crop;
}
