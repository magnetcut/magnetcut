import { beforeAll, describe, expect, test } from "bun:test";
import { registerDefaultMasks } from "@/masks";
import { buildHideRegionMask } from "../region";

describe("buildHideRegionMask", () => {
	beforeAll(() => registerDefaultMasks());

	const canvasSize = { width: 1920, height: 1080 };

	test("a face is an upright oval in the middle", () => {
		const mask = buildHideRegionMask({ shape: "face", canvasSize });
		expect(mask.type).toBe("ellipse");
		if (mask.type !== "ellipse") return;
		const { centerX, centerY, width, height } = mask.params;
		expect([centerX, centerY]).toEqual([0, 0]);
		// In pixels: taller than wide.
		expect(height * canvasSize.height).toBeGreaterThan(
			width * canvasSize.width,
		);
		expect(height).toBeCloseTo(0.25);
	});

	test("a plate is a wide rectangle", () => {
		const mask = buildHideRegionMask({ shape: "plate", canvasSize });
		expect(mask.type).toBe("rectangle");
		if (mask.type !== "rectangle") return;
		const ratio =
			(mask.params.width * canvasSize.width) /
			(mask.params.height * canvasSize.height);
		expect(ratio).toBeCloseTo(4.5);
		expect(mask.params.feather).toBe(0);
	});
});
