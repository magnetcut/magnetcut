/*
 * Pictures drawn in RGB turned into I420 in a video's colour space: the
 * matrix and range of the film a converted clip is joined to, so its samples
 * are coded the same way whatever the web view's encoder does with RGB
 * (Chromium's writes full range, WebKit's limited).
 */

// Each matrix's weights of red and blue in luma (H.273). Strings: web views
// name more than TypeScript's DOM types do.
const MATRIX_WEIGHTS: Partial<Record<string, { red: number; blue: number }>> = {
	bt709: { red: 0.2126, blue: 0.0722 },
	bt470bg: { red: 0.299, blue: 0.114 },
	smpte170m: { red: 0.299, blue: 0.114 },
	"bt2020-ncl": { red: 0.2627, blue: 0.0593 },
};

// The transfers of SDR video: a picture drawn in a canvas has lost HDR's
// (pq, hlg) and isn't linear.
const SDR_TRANSFERS = new Set<string>(["bt709", "smpte170m", "iec61966-2-1"]);

/**
 * The colour space a video is taken to be in where its file doesn't say:
 * BT.709, limited range, at any size, as WebKit and Chromium draw such a
 * film (where ffmpeg, VLC and mpv take one under 720 lines as BT.601).
 */
export function resolveVideoColour({
	colour,
}: {
	colour: VideoColorSpaceInit | null;
}): VideoColorSpaceInit {
	return {
		primaries: colour?.primaries ?? "bt709",
		transfer: colour?.transfer ?? "bt709",
		matrix: colour?.matrix ?? "bt709",
		fullRange: colour?.fullRange ?? false,
	};
}

/** Whether pictures drawn in RGB can be written in this colour space: a known matrix, SDR. */
export function canWriteColour({
	colour,
}: {
	// Strings: what a web view says may not be in TypeScript's DOM types.
	colour: { matrix?: string | null; transfer?: string | null };
}): boolean {
	return (
		!!colour.matrix &&
		!!MATRIX_WEIGHTS[colour.matrix] &&
		(!colour.transfer || SDR_TRANSFERS.has(colour.transfer))
	);
}

// Where red, green and blue are in an RGBA pixel read as one 32-bit number.
const IS_LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
const [RED_SHIFT, GREEN_SHIFT, BLUE_SHIFT] = IS_LITTLE_ENDIAN
	? [0, 8, 16]
	: [24, 16, 8];

/**
 * RGBA pixels as I420, tightly packed, in `colour`'s matrix and range. Each
 * chroma sample is made from the 2×2 pixels it covers (an odd edge's from
 * the ones there are); alpha is ignored.
 */
export function rgbaToI420({
	rgba,
	width,
	height,
	colour,
}: {
	rgba: Uint8ClampedArray;
	width: number;
	height: number;
	colour: VideoColorSpaceInit;
}): Uint8Array {
	const weights = colour.matrix ? MATRIX_WEIGHTS[colour.matrix] : undefined;
	if (!weights) throw new Error(`no RGB to YUV for ${colour.matrix}`);
	const { red, blue } = weights;
	const green = 1 - red - blue;
	const full = colour.fullRange ?? false;
	// Limited range is luma 16 to 235 and chroma 16 to 240; full 0 to 255.
	const lumaScale = (full ? 255 : 219) / 255;
	const lumaOffset = full ? 0 : 16;
	const chromaScale = (full ? 255 : 224) / 255;
	const blueScale = chromaScale / (2 * (1 - blue));
	const redScale = chromaScale / (2 * (1 - red));

	// Each channel's share of luma, in 1/65536ths, from a table.
	const [redShare, greenShare, blueShare] = [red, green, blue].map((weight) =>
		Int32Array.from({ length: 256 }, (_, value) =>
			Math.round(lumaScale * weight * value * 65536),
		),
	);
	const lumaStart = lumaOffset * 65536 + 32768;
	// Chroma, from a 2×2 block's average of each channel.
	const [blueFromRed, blueFromGreen, blueFromBlue] = [
		-red,
		-green,
		1 - blue,
	].map((weight) => blueScale * weight);
	const [redFromRed, redFromGreen, redFromBlue] = [1 - red, -green, -blue].map(
		(weight) => redScale * weight,
	);

	// Read four bytes at a time, which is several times faster.
	const pixels =
		rgba.byteOffset % 4 === 0
			? new Uint32Array(rgba.buffer, rgba.byteOffset, width * height)
			: new Uint32Array(rgba.slice(0, width * height * 4).buffer);
	const chromaWidth = Math.ceil(width / 2);
	const chromaHeight = Math.ceil(height / 2);
	const lumaSize = width * height;
	const chromaSize = chromaWidth * chromaHeight;
	// Clamped, so chroma written rounds and stays in 0 to 255.
	const out = new Uint8ClampedArray(lumaSize + 2 * chromaSize);
	for (let i = 0; i < lumaSize; i++) {
		const pixel = pixels[i];
		out[i] =
			(lumaStart +
				redShare[(pixel >>> RED_SHIFT) & 255] +
				greenShare[(pixel >>> GREEN_SHIFT) & 255] +
				blueShare[(pixel >>> BLUE_SHIFT) & 255]) >>
			16;
	}
	for (let row = 0; row < chromaHeight; row++) {
		const top = row * 2 * width;
		const below = row * 2 + 1 < height ? width : 0;
		for (let column = 0; column < chromaWidth; column++) {
			const left = column * 2;
			const right = left + 1 < width ? 1 : 0;
			const a = pixels[top + left];
			const b = pixels[top + left + right];
			const c = pixels[top + below + left];
			const d = pixels[top + below + left + right];
			const r =
				(((a >>> RED_SHIFT) & 255) +
					((b >>> RED_SHIFT) & 255) +
					((c >>> RED_SHIFT) & 255) +
					((d >>> RED_SHIFT) & 255)) /
				4;
			const g =
				(((a >>> GREEN_SHIFT) & 255) +
					((b >>> GREEN_SHIFT) & 255) +
					((c >>> GREEN_SHIFT) & 255) +
					((d >>> GREEN_SHIFT) & 255)) /
				4;
			const bl =
				(((a >>> BLUE_SHIFT) & 255) +
					((b >>> BLUE_SHIFT) & 255) +
					((c >>> BLUE_SHIFT) & 255) +
					((d >>> BLUE_SHIFT) & 255)) /
				4;
			const index = row * chromaWidth + column;
			out[lumaSize + index] =
				128 + blueFromRed * r + blueFromGreen * g + blueFromBlue * bl;
			out[lumaSize + chromaSize + index] =
				128 + redFromRed * r + redFromGreen * g + redFromBlue * bl;
		}
	}
	return new Uint8Array(out.buffer);
}
