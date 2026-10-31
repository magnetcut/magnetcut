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

function overlap({ a, b }: { a: Detection; b: Detection }): number {
	const left = Math.max(a.x, b.x);
	const top = Math.max(a.y, b.y);
	const right = Math.min(a.x + a.width, b.x + b.width);
	const bottom = Math.min(a.y + a.height, b.y + b.height);
	const shared = Math.max(0, right - left) * Math.max(0, bottom - top);
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
