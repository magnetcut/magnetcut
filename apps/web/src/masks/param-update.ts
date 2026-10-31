import type { Mask } from "@/masks/types";
import { FEATHER_HANDLE_SCALE, MAX_FEATHER } from "@/masks/feather";

export function computeFeatherUpdate({
	startFeather,
	deltaX,
	deltaY,
	directionX,
	directionY,
}: {
	startFeather: number;
	deltaX: number;
	deltaY: number;
	directionX: number;
	directionY: number;
}): { feather: number } {
	const projection = deltaX * directionX + deltaY * directionY;
	return {
		feather: Math.max(
			0,
			Math.min(
				MAX_FEATHER,
				Math.round(startFeather + projection / FEATHER_HANDLE_SCALE),
			),
		),
	};
}

/** The mask with one parameter changed, typed as its kind of mask. */
export function withMaskParam({
	mask,
	key,
	value,
}: {
	mask: Mask;
	key: string;
	value: number | string | boolean;
}): Mask {
	switch (mask.type) {
		case "split":
			return { ...mask, params: { ...mask.params, [key]: value } };
		case "cinematic-bars":
			return { ...mask, params: { ...mask.params, [key]: value } };
		case "rectangle":
			return { ...mask, params: { ...mask.params, [key]: value } };
		case "ellipse":
			return { ...mask, params: { ...mask.params, [key]: value } };
		case "heart":
			return { ...mask, params: { ...mask.params, [key]: value } };
		case "diamond":
			return { ...mask, params: { ...mask.params, [key]: value } };
		case "star":
			return { ...mask, params: { ...mask.params, [key]: value } };
		case "text":
			return { ...mask, params: { ...mask.params, [key]: value } };
		case "freeform":
			return { ...mask, params: { ...mask.params, [key]: value } };
	}
}
