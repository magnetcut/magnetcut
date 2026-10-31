import { beforeAll, describe, expect, test } from "bun:test";
import { registerDefaultMasks } from "@/masks";
import {
	buildMaskParamPath,
	hasMaskKeyframes,
	parseMaskParamPath,
	resolveMaskAtTime,
	upsertMaskKeyframes,
} from "@/masks/keyframes";
import { buildHideRegionMask } from "@/hide/region";
import { resolveAnimationTarget } from "@/timeline/animation-targets";
import type { EffectElement } from "@/timeline";
import { mediaTime, ZERO_MEDIA_TIME, TICKS_PER_SECOND } from "@/wasm";

beforeAll(() => registerDefaultMasks());

const second = mediaTime({ ticks: TICKS_PER_SECOND });

function region() {
	return buildHideRegionMask({
		shape: "face",
		canvasSize: { width: 1920, height: 1080 },
	});
}

describe("mask keyframes", () => {
	test("a path names the mask and the parameter", () => {
		const path = buildMaskParamPath({ maskId: "m1", paramKey: "centerX" });
		expect(path).toBe("masks.m1.params.centerX");
		expect(parseMaskParamPath({ propertyPath: path })).toEqual({
			maskId: "m1",
			paramKey: "centerX",
		});
		expect(
			parseMaskParamPath({ propertyPath: "effects.e.params.x" }),
		).toBeNull();
	});

	test("a mask keyframed in two places moves between them", () => {
		const mask = region();
		let animations = upsertMaskKeyframes({
			animations: undefined,
			mask,
			params: { centerX: -0.2 },
			time: ZERO_MEDIA_TIME,
		});
		animations = upsertMaskKeyframes({
			animations,
			mask,
			params: { centerX: 0.2 },
			time: second,
		});
		expect(hasMaskKeyframes({ mask, animations })).toBe(true);
		const centerAt = (ticks: number) => {
			const resolved = resolveMaskAtTime({
				mask,
				animations,
				localTime: ticks,
			});
			return "centerX" in resolved.params ? resolved.params.centerX : NaN;
		};
		expect(centerAt(0)).toBeCloseTo(-0.2);
		expect(centerAt(TICKS_PER_SECOND / 2)).toBeCloseTo(0, 1);
		expect(centerAt(TICKS_PER_SECOND)).toBeCloseTo(0.2);
		// Unkeyed parameters are as they were.
		const resolved = resolveMaskAtTime({ mask, animations, localTime: 0 });
		expect("height" in resolved.params && resolved.params.height).toBe(
			"height" in mask.params && mask.params.height,
		);
	});

	test("a keyframe keeps a place finer than a percent of the picture", () => {
		const mask = region();
		const animations = upsertMaskKeyframes({
			animations: undefined,
			mask,
			params: { centerX: 0.1234 },
			time: ZERO_MEDIA_TIME,
		});
		const resolved = resolveMaskAtTime({ mask, animations, localTime: 0 });
		const centerX =
			"centerX" in resolved.params ? resolved.params.centerX : NaN;
		expect(centerX).toBeCloseTo(0.1234, 4);
	});

	test("an adjustment layer's mask is a target the timeline's commands take", () => {
		const mask = region();
		const element: EffectElement = {
			id: "e1",
			name: "Blur face",
			type: "effect",
			effectType: "blur",
			params: { intensity: 70 },
			startTime: ZERO_MEDIA_TIME,
			duration: second,
			trimStart: ZERO_MEDIA_TIME,
			trimEnd: ZERO_MEDIA_TIME,
			masks: [mask],
		};
		const target = resolveAnimationTarget({
			element,
			path: buildMaskParamPath({ maskId: mask.id, paramKey: "centerY" }),
		});
		expect(target).not.toBeNull();
		const moved = target?.setBaseValue({ value: 0.3 });
		const movedMask = moved && "masks" in moved ? moved.masks?.[0] : undefined;
		expect(
			movedMask && "centerY" in movedMask.params && movedMask.params.centerY,
		).toBe(0.3);
	});
});
