import { describe, expect, test } from "bun:test";
import {
	crop,
	decodeYolo,
	decodeYuNet,
	fromLetterbox,
	letterbox,
	matchDetections,
	merge,
	suppress,
	tiles,
} from "../detect";

describe("letterbox", () => {
	test("fits a wide frame in the square, and takes boxes back", () => {
		const rgba = new Uint8ClampedArray(200 * 100 * 4).fill(255);
		const box = letterbox({
			rgba,
			width: 200,
			height: 100,
			size: 64,
			order: "rgb1",
		});
		expect(box.scale).toBeCloseTo(0.32);
		expect(box.offsetY).toBe(16);
		// Inside the fitted picture: white; the bands above and below: grey.
		expect(box.data[32 * 64 + 32]).toBeCloseTo(1);
		expect(box.data[2 * 64 + 32]).toBeCloseTo(114 / 255);
		const back = fromLetterbox({
			detection: { x: 16, y: 24, width: 32, height: 16, score: 1 },
			box,
		});
		expect([back.x, back.y, back.width, back.height]).toEqual([
			50, 25, 100, 50,
		]);
	});
});

describe("decodeYuNet", () => {
	test("a sure cell is a face around it", () => {
		const size = 32;
		const outputs: Record<string, Float32Array> = {};
		for (const stride of [8, 16, 32]) {
			const cells = (size / stride) ** 2;
			outputs[`cls_${stride}`] = new Float32Array(cells);
			outputs[`obj_${stride}`] = new Float32Array(cells);
			outputs[`bbox_${stride}`] = new Float32Array(cells * 4);
		}
		// Stride 8, row 1, column 2: a face 16 wide, 24 high, there.
		const index = 1 * 4 + 2;
		outputs.cls_8[index] = 0.9;
		outputs.obj_8[index] = 0.9;
		outputs.bbox_8.set([0.5, 0.5, Math.log(2), Math.log(3)], index * 4);
		const [face, ...rest] = decodeYuNet({ outputs, size, threshold: 0.5 });
		expect(rest).toHaveLength(0);
		expect(face.score).toBeCloseTo(0.9);
		const expected = [12, 0, 16, 24];
		for (const [index, value] of [
			face.x,
			face.y,
			face.width,
			face.height,
		].entries()) {
			expect(value).toBeCloseTo(expected[index], 4);
		}
	});
});

describe("decodeYolo", () => {
	test("reads each column as a box", () => {
		const count = 3;
		const output = new Float32Array(5 * count);
		// Box 1: middle (100, 50), 40 by 20, sure.
		output.set([0, 100, 0], 0);
		output.set([0, 50, 0], count);
		output.set([0, 40, 0], 2 * count);
		output.set([0, 20, 0], 3 * count);
		output.set([0.1, 0.9, 0.2], 4 * count);
		const found = decodeYolo({ output, count, threshold: 0.5 });
		expect(found).toEqual([
			{ x: 80, y: 40, width: 40, height: 20, score: expect.closeTo(0.9) },
		]);
	});
});

describe("suppress", () => {
	test("keeps the surest of boxes on the same thing", () => {
		const kept = suppress({
			detections: [
				{ x: 0, y: 0, width: 10, height: 10, score: 0.6 },
				{ x: 1, y: 1, width: 10, height: 10, score: 0.9 },
				{ x: 50, y: 50, width: 10, height: 10, score: 0.7 },
			],
			threshold: 0.3,
		});
		expect(kept.map(({ score }) => score)).toEqual([0.9, 0.7]);
	});
});

describe("matchDetections", () => {
	const box = (x: number) => ({ x, y: 0, width: 10, height: 10, score: 1 });

	test("pairs neighbours by the best overlaps, not by the order found", () => {
		// Two faces side by side, a little apart; found in the other order,
		// each moved towards the other's side. Taken one by one, the first
		// find would go to the wrong one.
		const { pairs, unmatched } = matchDetections({
			known: [box(0), box(8)],
			found: [box(4), box(1)],
			threshold: 0.3,
		});
		expect(pairs.sort()).toEqual([
			[0, 1],
			[1, 0],
		]);
		expect(unmatched).toEqual([]);
	});

	test("leaves a find that overlaps nothing for a new region", () => {
		const { pairs, unmatched } = matchDetections({
			known: [box(0)],
			found: [box(1), box(50)],
			threshold: 0.3,
		});
		expect(pairs).toEqual([[0, 0]]);
		expect(unmatched).toEqual([1]);
	});
});

describe("tiles", () => {
	test("covers a wide frame with squares of its height, edge to edge", () => {
		expect(tiles({ width: 1280, height: 720, size: 640 })).toEqual([
			{ x: 0, y: 0, side: 720 },
			{ x: 560, y: 0, side: 720 },
		]);
	});

	test("cuts a big square frame in four", () => {
		const parts = tiles({ width: 1280, height: 1280, size: 640 });
		expect(parts).toHaveLength(4);
		expect(parts.every((part) => part.side === 800)).toBe(true);
		expect(parts.at(-1)).toEqual({ x: 480, y: 480, side: 800 });
	});

	test("leaves a frame about the model's size whole", () => {
		expect(tiles({ width: 640, height: 360, size: 640 })).toEqual([]);
	});
});

describe("crop", () => {
	test("takes a square out of a frame, row by row", () => {
		// A 4×3 frame, each pixel's red its index.
		const rgba = new Uint8ClampedArray(4 * 3 * 4);
		for (let i = 0; i < 12; i++) rgba[i * 4] = i;
		const square = crop({ rgba, width: 4, x: 1, y: 1, side: 2 });
		expect([square[0], square[4], square[8], square[12]]).toEqual([
			5, 6, 9, 10,
		]);
	});
});

describe("merge", () => {
	test("keeps one of a face found twice, and drops a part of one", () => {
		const face = { x: 100, y: 100, width: 40, height: 50, score: 0.9 };
		const again = { x: 102, y: 101, width: 40, height: 50, score: 0.8 };
		// Cut by a square's edge: its left half.
		const part = { x: 100, y: 100, width: 18, height: 50, score: 0.7 };
		const other = { x: 300, y: 100, width: 40, height: 50, score: 0.75 };
		expect(
			merge({ detections: [part, again, other, face], threshold: 0.3 }),
		).toEqual([face, other]);
	});
});
