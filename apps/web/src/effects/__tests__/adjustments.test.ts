import { describe, expect, test } from "bun:test";
import { resolveEffectPasses } from "@/effects";
import {
	colorAdjustmentDefinition,
	sharpenDefinition,
	vignetteDefinition,
} from "../definitions/adjustments";

describe("adjustments", () => {
	test("give the colour pass its settings as the shader takes them", () => {
		const [pass] = resolveEffectPasses({
			definition: colorAdjustmentDefinition,
			effectParams: { saturation: 50, exposure: -100, hue: 90 },
			width: 1920,
			height: 1080,
		});
		expect(pass.shader).toBe("color-adjust");
		expect(pass.uniforms).toMatchObject({
			u_saturation: 0.5,
			u_exposure: -1,
			u_hue: 90,
			u_contrast: 0,
		});
	});

	test("are all adjustments, apart from the Effects tab's", () => {
		for (const definition of [
			colorAdjustmentDefinition,
			vignetteDefinition,
			sharpenDefinition,
		]) {
			expect(definition.category).toBe("adjustment");
		}
		const [sharpen] = resolveEffectPasses({
			definition: sharpenDefinition,
			effectParams: { amount: 50 },
			width: 100,
			height: 100,
		});
		expect(sharpen.uniforms.u_amount).toBe(1);
	});
});
