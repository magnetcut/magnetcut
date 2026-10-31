import {
	hasKeyframesForPath,
	resolveAnimationPathValueAtTime,
	upsertPathKeyframe,
} from "@/animation";
import type { ElementAnimations } from "@/animation/types";
import {
	coerceParamValue,
	getParamChannelLayout,
	type ParamDefinition,
	type ParamValue,
} from "@/params";
import type { MediaTime } from "@/wasm";
import { getMaskDefinition } from "./index";
import { withMaskParam } from "./param-update";
import { BASE_MASK_PARAM_DEFINITIONS } from "./registry";
import type { Mask } from "./types";

// Keyframes on a mask's parameters, on the element's animations as
// `masks.<mask id>.params.<key>`: a mask that follows what moves, a Hide
// region's above all (docs/HIDE.md).

export const MASK_PARAM_PATH_PREFIX = "masks.";
export const MASK_PARAM_PATH_SUFFIX = ".params.";

/** The parameters a mask's place and size are: keyframed together. */
export const MASK_GEOMETRY_KEYS = [
	"centerX",
	"centerY",
	"width",
	"height",
	"rotation",
	"scale",
] as const;

export function buildMaskParamPath({
	maskId,
	paramKey,
}: {
	maskId: string;
	paramKey: string;
}): string {
	return `${MASK_PARAM_PATH_PREFIX}${maskId}${MASK_PARAM_PATH_SUFFIX}${paramKey}`;
}

export function parseMaskParamPath({
	propertyPath,
}: {
	propertyPath: string;
}): { maskId: string; paramKey: string } | null {
	if (!propertyPath.startsWith(MASK_PARAM_PATH_PREFIX)) {
		return null;
	}
	const rest = propertyPath.slice(MASK_PARAM_PATH_PREFIX.length);
	const separator = rest.indexOf(MASK_PARAM_PATH_SUFFIX);
	if (separator <= 0) {
		return null;
	}
	const maskId = rest.slice(0, separator);
	const paramKey = rest.slice(separator + MASK_PARAM_PATH_SUFFIX.length);
	return maskId && paramKey ? { maskId, paramKey } : null;
}

/**
 * The definition of a mask's parameter, its type's own or one all masks have,
 * in the units it's stored in: a mask's sizes and places are shares of its
 * element, shown as percentages, their ranges and steps given as shown.
 */
export function getMaskParamDefinition({
	mask,
	paramKey,
}: {
	mask: Mask;
	paramKey: string;
}): ParamDefinition | undefined {
	const definition = getMaskDefinition(mask.type);
	const param = [...definition.params, ...BASE_MASK_PARAM_DEFINITIONS].find(
		(candidate) => candidate.key === paramKey,
	);
	if (param?.type !== "number" || !param.displayMultiplier) {
		return param;
	}
	const multiplier = param.displayMultiplier;
	return {
		...param,
		min: param.min / multiplier,
		max: param.max === undefined ? undefined : param.max / multiplier,
		step: param.step / multiplier,
		displayMultiplier: undefined,
	};
}

/** Whether any of the mask's parameters has keyframes. */
export function hasMaskKeyframes({
	mask,
	animations,
}: {
	mask: Mask;
	animations: ElementAnimations | undefined;
}): boolean {
	return Object.keys(mask.params).some((paramKey) =>
		hasKeyframesForPath({
			animations,
			propertyPath: buildMaskParamPath({ maskId: mask.id, paramKey }),
		}),
	);
}

/** The mask as it is at `localTime`: its keyframed parameters resolved. */
export function resolveMaskAtTime({
	mask,
	animations,
	localTime,
}: {
	mask: Mask;
	animations: ElementAnimations | undefined;
	localTime: number;
}): Mask {
	if (!animations) {
		return mask;
	}
	let resolved = mask;
	for (const [paramKey, value] of Object.entries(mask.params)) {
		const propertyPath = buildMaskParamPath({ maskId: mask.id, paramKey });
		if (typeof value !== "number" || !animations[propertyPath]) {
			continue;
		}
		resolved = withMaskParam({
			mask: resolved,
			key: paramKey,
			value: resolveAnimationPathValueAtTime({
				animations,
				propertyPath,
				localTime: Math.max(0, localTime),
				fallbackValue: value,
			}),
		});
	}
	return resolved;
}

/** Keyframes at `time` for each of these parameters, at their values. */
export function upsertMaskKeyframes({
	animations,
	mask,
	params,
	time,
}: {
	animations: ElementAnimations | undefined;
	mask: Mask;
	params: Record<string, ParamValue>;
	time: MediaTime;
}): ElementAnimations | undefined {
	let next = animations;
	for (const [paramKey, value] of Object.entries(params)) {
		const param = getMaskParamDefinition({ mask, paramKey });
		if (!param || param.keyframable === false) {
			continue;
		}
		next = upsertPathKeyframe({
			animations: next,
			propertyPath: buildMaskParamPath({ maskId: mask.id, paramKey }),
			time,
			value,
			channelLayout: getParamChannelLayout({ param }),
			coerceValue: ({ value: candidate }) =>
				coerceParamValue({ param, value: candidate }),
		});
	}
	return next;
}
