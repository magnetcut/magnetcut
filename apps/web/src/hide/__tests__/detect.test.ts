import { describe, expect, test } from "bun:test";
import {
	decodeYolo,
	decodeYuNet,
	fromLetterbox,
	letterbox,
	suppress,
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
