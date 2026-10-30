import { describe, expect, test } from "bun:test";
import { NO_FILTERS, buildFilterPasses, hasFilters } from "../filters";

describe("buildFilterPasses", () => {
	test("is nothing with the filters off", () => {
		expect(buildFilterPasses({ filters: NO_FILTERS })).toEqual({
			source: [],
			frame: [],
		});
		expect(hasFilters({ filters: NO_FILTERS })).toBe(false);
	});

	test("deinterlaces then denoises each video, and sharpens the frame", () => {
		const passes = buildFilterPasses({
			filters: { deinterlace: true, denoise: "medium", sharpen: "light" },
		});
		expect(passes.source).toEqual([
			[
				{ shader: "deinterlace", uniforms: { u_field: 0 } },
				{ shader: "denoise", uniforms: { u_spatial: 1.5, u_range: 0.1 } },
			],
		]);
		expect(passes.frame).toEqual([
			[{ shader: "sharpen", uniforms: { u_amount: 0.5 } }],
		]);
	});

	test("each strength goes further than the last", () => {
		const amount = (sharpen: "light" | "medium" | "strong") =>
			buildFilterPasses({ filters: { ...NO_FILTERS, sharpen } }).frame[0][0]
				.uniforms.u_amount;
		expect(amount("light")).toBeLessThan(Number(amount("medium")));
		expect(amount("medium")).toBeLessThan(Number(amount("strong")));
	});
});
