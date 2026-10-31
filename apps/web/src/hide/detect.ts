// Faces and plates found by small detection models, run on the computer
// (docs/HIDE.md, phase 3): YuNet (OpenCV's, MIT) for faces, a YOLOv11 tuned
// for plates (AGPL-3.0, as MagnetCut is). The models are downloaded once,
// when first used, from Hugging Face; nothing is uploaded.

/** A box found, in the frame's pixels, and how sure the model is (0 to 1). */
export interface Detection {
	x: number;
	y: number;
	width: number;
	height: number;
	score: number;
}

/** A frame scaled to fit a square of `size`, centred, as a model's input:
 * where it went, to take what's found back to the frame. */
export interface Letterbox {
	data: Float32Array;
	scale: number;
	offsetX: number;
	offsetY: number;
}

/**
 * RGBA pixels as a model's input, NCHW, fitted into a `size` square on grey:
 * BGR from 0 to 255 for YuNet (as OpenCV gives it), RGB from 0 to 1 for YOLO.
 */
export function letterbox({
	rgba,
	width,
	height,
	size,
	order,
}: {
	rgba: Uint8ClampedArray;
	width: number;
	height: number;
	size: number;
	order: "bgr255" | "rgb1";
}): Letterbox {
	const scale = Math.min(size / width, size / height);
	const fittedWidth = Math.round(width * scale);
	const fittedHeight = Math.round(height * scale);
	const offsetX = Math.floor((size - fittedWidth) / 2);
	const offsetY = Math.floor((size - fittedHeight) / 2);
	const plane = size * size;
	const data = new Float32Array(3 * plane);
	const unit = order === "rgb1" ? 1 / 255 : 1;
	data.fill(114 * unit);
	for (let y = 0; y < fittedHeight; y++) {
		const sourceY = Math.min(height - 1, Math.floor((y + 0.5) / scale));
		for (let x = 0; x < fittedWidth; x++) {
			const sourceX = Math.min(width - 1, Math.floor((x + 0.5) / scale));
			const from = (sourceY * width + sourceX) * 4;
			const to = (y + offsetY) * size + x + offsetX;
			const [r, g, b] = [rgba[from], rgba[from + 1], rgba[from + 2]];
			const [first, second, third] = order === "rgb1" ? [r, g, b] : [b, g, r];
			data[to] = first * unit;
			data[plane + to] = second * unit;
			data[2 * plane + to] = third * unit;
		}
	}
	return { data, scale, offsetX, offsetY };
}

/** A box found in the model's square, back in the frame's pixels. */
export function fromLetterbox({
	detection,
	box,
}: {
	detection: Detection;
	box: Letterbox;
}): Detection {
	return {
		x: (detection.x - box.offsetX) / box.scale,
		y: (detection.y - box.offsetY) / box.scale,
		width: detection.width / box.scale,
		height: detection.height / box.scale,
		score: detection.score,
	};
}

/** The area two boxes share. */
function sharedArea({ a, b }: { a: Detection; b: Detection }): number {
	const left = Math.max(a.x, b.x);
	const top = Math.max(a.y, b.y);
	const right = Math.min(a.x + a.width, b.x + b.width);
	const bottom = Math.min(a.y + a.height, b.y + b.height);
	return Math.max(0, right - left) * Math.max(0, bottom - top);
}

function overlap({ a, b }: { a: Detection; b: Detection }): number {
	const shared = sharedArea({ a, b });
	const union = a.width * a.height + b.width * b.height - shared;
	return union > 0 ? shared / union : 0;
}

/** The surest box of each group overlapping by more than `threshold`. */
export function suppress({
	detections,
	threshold,
}: {
	detections: Detection[];
	threshold: number;
}): Detection[] {
	const kept: Detection[] = [];
	for (const detection of [...detections].sort((a, b) => b.score - a.score)) {
		if (
			kept.every((other) => overlap({ a: detection, b: other }) <= threshold)
		) {
			kept.push(detection);
		}
	}
	return kept;
}

// A box this much inside a surer one is a part of what that one found: a
// face cut by a square's edge.
const INSIDE = 0.6;

/**
 * Finds from a frame and from squares of it, as one: the surest of each
 * group overlapping by more than `threshold`, and none mostly inside a surer
 * one.
 */
export function merge({
	detections,
	threshold,
}: {
	detections: Detection[];
	threshold: number;
}): Detection[] {
	const kept: Detection[] = [];
	for (const detection of [...detections].sort((a, b) => b.score - a.score)) {
		const area = detection.width * detection.height;
		if (
			kept.every(
				(other) =>
					overlap({ a: detection, b: other }) <= threshold &&
					sharedArea({ a: detection, b: other }) <= INSIDE * area,
			)
		) {
			kept.push(detection);
		}
	}
	return kept;
}

/**
 * Squares of a frame for the model to look at closer, when the frame is a
 * quarter bigger than the model's `size` or more: the shorter side's, or a
 * quarter more than the model's if that's smaller, spread evenly from edge to
 * edge, overlapping. None for a frame about the model's size.
 */
export function tiles({
	width,
	height,
	size,
}: {
	width: number;
	height: number;
	size: number;
}): Array<{ x: number; y: number; side: number }> {
	if (Math.max(width, height) < size * 1.25) return [];
	const side = Math.min(width, height, Math.round(size * 1.25));
	const along = (length: number) => {
		const count = Math.ceil(length / side);
		return Array.from({ length: count }, (_, i) =>
			count === 1 ? 0 : Math.round((i * (length - side)) / (count - 1)),
		);
	};
	return along(height).flatMap((y) =>
		along(width).map((x) => ({ x, y, side })),
	);
}

/** The square of `side` at (`x`, `y`) of an RGBA frame `width` wide. */
export function crop({
	rgba,
	width,
	x,
	y,
	side,
}: {
	rgba: Uint8ClampedArray;
	width: number;
	x: number;
	y: number;
	side: number;
}): Uint8ClampedArray {
	const square = new Uint8ClampedArray(side * side * 4);
	for (let row = 0; row < side; row++) {
		const from = ((y + row) * width + x) * 4;
		square.set(rgba.subarray(from, from + side * 4), row * side * 4);
	}
	return square;
}

/** Boxes overlapping, as a share of both: for tracks found again. */
export function intersectionOverUnion({
	a,
	b,
}: {
	a: Detection;
	b: Detection;
}): number {
	return overlap({ a, b });
}

/**
 * Faces in YuNet's outputs (per stride: cls, obj, bbox), as OpenCV's
 * FaceDetectorYN reads them: in the model's square of `size`.
 */
export function decodeYuNet({
	outputs,
	size,
	threshold,
}: {
	outputs: Record<string, Float32Array>;
	size: number;
	threshold: number;
}): Detection[] {
	const found: Detection[] = [];
	for (const stride of [8, 16, 32]) {
		const cls = outputs[`cls_${stride}`];
		const obj = outputs[`obj_${stride}`];
		const bbox = outputs[`bbox_${stride}`];
		if (!cls || !obj || !bbox) continue;
		const columns = size / stride;
		for (let index = 0; index < cls.length; index++) {
			const score = Math.sqrt(
				Math.min(1, Math.max(0, cls[index])) *
					Math.min(1, Math.max(0, obj[index])),
			);
			if (score < threshold) continue;
			const row = Math.floor(index / columns);
			const column = index % columns;
			const centerX = (column + bbox[index * 4]) * stride;
			const centerY = (row + bbox[index * 4 + 1]) * stride;
			const width = Math.exp(bbox[index * 4 + 2]) * stride;
			const height = Math.exp(bbox[index * 4 + 3]) * stride;
			found.push({
				x: centerX - width / 2,
				y: centerY - height / 2,
				width,
				height,
				score,
			});
		}
	}
	return suppress({ detections: found, threshold: 0.3 });
}

/**
 * Boxes in a one-class YOLO's output, `[1, 5, n]`: each column a box's
 * middle, size and score, in the model's square.
 */
export function decodeYolo({
	output,
	count,
	threshold,
}: {
	output: Float32Array;
	count: number;
	threshold: number;
}): Detection[] {
	const found: Detection[] = [];
	for (let index = 0; index < count; index++) {
		const score = output[4 * count + index];
		if (score < threshold) continue;
		const width = output[2 * count + index];
		const height = output[3 * count + index];
		found.push({
			x: output[index] - width / 2,
			y: output[count + index] - height / 2,
			width,
			height,
			score,
		});
	}
	return suppress({ detections: found, threshold: 0.45 });
}

/**
 * Each box found matched to the known one it overlaps most, the best
 * overlaps first, so that neighbours in a crowd aren't swapped: pairs of
 * (known, found) indices, and the found ones no known box had.
 */
export function matchDetections({
	known,
	found,
	threshold,
}: {
	known: Detection[];
	found: Detection[];
	threshold: number;
}): { pairs: Array<[number, number]>; unmatched: number[] } {
	const overlaps: Array<{ known: number; found: number; overlap: number }> = [];
	for (const [k, a] of known.entries()) {
		for (const [f, b] of found.entries()) {
			const overlap = intersectionOverUnion({ a, b });
			if (overlap >= threshold) overlaps.push({ known: k, found: f, overlap });
		}
	}
	overlaps.sort((a, b) => b.overlap - a.overlap);
	const usedKnown = new Set<number>();
	const usedFound = new Set<number>();
	const pairs: Array<[number, number]> = [];
	for (const { known: k, found: f } of overlaps) {
		if (usedKnown.has(k) || usedFound.has(f)) continue;
		usedKnown.add(k);
		usedFound.add(f);
		pairs.push([k, f]);
	}
	const unmatched = found.map((_, f) => f).filter((f) => !usedFound.has(f));
	return { pairs, unmatched };
}
