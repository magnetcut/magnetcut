import { buildDefaultMaskInstance } from "@/masks";
import type { Mask } from "@/masks/types";
import type { ParamValues } from "@/params";

// Hide regions (docs/HIDE.md): an adjustment layer over a face or a plate,
// its effect applied only within its mask.

export const HIDE_SHAPES = ["face", "plate"] as const;
export type HideShape = (typeof HIDE_SHAPES)[number];

export const HIDE_SHAPE_NAMES: Record<HideShape, string> = {
	face: "Face",
	plate: "Plate",
};

/** The looks: the effect each adds, and its settings for hiding (a blur
 * strong enough that a face can't be made out). */
export const HIDE_LOOKS = [
	{ effectType: "blur", name: "Blur", params: { intensity: 70 } },
	{ effectType: "pixelate", name: "Pixelate", params: {} },
	{ effectType: "cover", name: "Cover", params: {} },
] as const satisfies ReadonlyArray<{
	effectType: string;
	name: string;
	params: ParamValues;
}>;

/** A region in the middle of the picture: an upright oval for a face, a
 * plate's wide rectangle. Sizes are shares of the canvas, which a Hide
 * region's mask is placed in. */
export function buildHideRegionMask({
	shape,
	canvasSize,
}: {
	shape: HideShape;
	canvasSize: { width: number; height: number };
}): Mask {
	const aspect = canvasSize.width / Math.max(canvasSize.height, 1);
	const mask = buildDefaultMaskInstance({
		maskType: shape === "face" ? "ellipse" : "rectangle",
		elementSize: canvasSize,
	});
	if (mask.type !== "ellipse" && mask.type !== "rectangle") {
		return mask;
	}
	// A face a quarter of the picture high, four fifths as wide; a plate a
	// fifth of the picture wide, 4.5 times as wide as it is high.
	const size =
		shape === "face"
			? { width: (0.25 * 0.8) / aspect, height: 0.25 }
			: { width: 0.2, height: (0.2 * aspect) / 4.5 };
	return {
		...mask,
		params: {
			...mask.params,
			...size,
			centerX: 0,
			centerY: 0,
			feather: shape === "face" ? 8 : 0,
		},
	};
}
