import { expect, test } from "bun:test";
import { findCuts, histogram } from "../shots";

/** A frame of one grey, with a little noise. */
function frame({
	grey,
	seed,
}: {
	grey: number;
	seed: number;
}): Uint8ClampedArray {
	const rgba = new Uint8ClampedArray(32 * 18 * 4);
	for (let i = 0; i < rgba.length; i += 4) {
		const noise = ((i * 7919 + seed * 104_729) % 13) - 6;
		rgba[i] = rgba[i + 1] = rgba[i + 2] = grey + noise;
		rgba[i + 3] = 255;
	}
	return rgba;
}

test("a cut is where the picture changes far more than around it", () => {
	// Ten frames of a dark shot, slowly brightening, then ten of a bright one.
	const histograms = [
		...Array.from({ length: 10 }, (_, i) =>
			histogram({ rgba: frame({ grey: 40 + i, seed: i }) }),
		),
		...Array.from({ length: 10 }, (_, i) =>
			histogram({ rgba: frame({ grey: 200, seed: i + 10 }) }),
		),
	];
	expect(findCuts({ histograms })).toEqual([10]);
});

test("a shot that moves, without cutting, has none", () => {
	const histograms = Array.from({ length: 30 }, (_, i) =>
		histogram({ rgba: frame({ grey: 60 + i * 3, seed: i }) }),
	);
	expect(findCuts({ histograms })).toEqual([]);
});
