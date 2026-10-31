import type {
	AnimationInterpolation,
	AnimationPath,
	NumericSpec,
} from "@/animation/types";
import {
	parseEffectParamPath,
} from "@/animation/effect-param-channel";
import {
	parseGraphicParamPath,
} from "@/animation/graphic-param-channel";
import { effectsRegistry, registerDefaultEffects } from "@/effects";
import { getGraphicDefinition } from "@/graphics";
import {
	coerceParamValue,
	getParamDefaultInterpolation,
	getParamChannelLayout,
	getParamNumericRange,
	type ParamChannelLayout,
	type ParamDefinition,
	type ParamValue,
	type ParamValues,
} from "@/params";
import {
	getElementParam,
} from "@/params/registry";
import type { TimelineElement } from "@/timeline";
import { isMaskableElement, isVisualElement } from "@/timeline/element-utils";
import {
	getMaskParamDefinition,
	parseMaskParamPath,
} from "@/masks/keyframes";
import { withMaskParam } from "@/masks/param-update";

export interface AnimationPathDescriptor {
	channelLayout: ParamChannelLayout;
	defaultInterpolation: AnimationInterpolation;
	numericRanges?: Partial<Record<string, NumericSpec>>;
	coerceValue: ({ value }: { value: ParamValue }) => ParamValue | null;
	getBaseValue: () => ParamValue | null;
	setBaseValue: ({ value }: { value: ParamValue }) => TimelineElement;
}

// Leaf params expose a single component named "value". Composite params don't
// carry numeric ranges yet — revisit when one does.
function paramNumericRanges({
	param,
}: {
	param: ParamDefinition;
}): Partial<Record<string, NumericSpec>> | undefined {
	const range = getParamNumericRange({ param });
	return range ? { value: range } : undefined;
}

function buildParamDescriptor({
	param,
	baseParams,
	setParams,
}: {
	param: ParamDefinition;
	baseParams: ParamValues;
	setParams: (params: ParamValues) => TimelineElement;
}): AnimationPathDescriptor | null {
	if (param.keyframable === false) {
		return null;
	}

	return {
		channelLayout: getParamChannelLayout({ param }),
		defaultInterpolation: getParamDefaultInterpolation({ param }),
		numericRanges: paramNumericRanges({ param }),
		coerceValue: ({ value }) => coerceParamValue({ param, value }),
		getBaseValue: () => baseParams[param.key] ?? param.default,
		setBaseValue: ({ value }) => {
			const coercedValue = coerceParamValue({ param, value });
			if (coercedValue === null) {
				return setParams(baseParams);
			}

			return setParams({
				...baseParams,
				[param.key]: coercedValue,
			});
		},
	};
}

function buildElementParamDescriptor({
	element,
	paramKey,
}: {
	element: TimelineElement;
	paramKey: string;
}): AnimationPathDescriptor | null {
	const param = getElementParam({ element, key: paramKey });
	if (!param) {
		return null;
	}

	return buildParamDescriptor({
		param,
		baseParams: element.params,
		setParams: (params) => ({
			...element,
			params,
		}),
	});
}

function buildGraphicParamDescriptor({
	element,
	paramKey,
}: {
	element: TimelineElement;
	paramKey: string;
}): AnimationPathDescriptor | null {
	if (element.type !== "graphic") {
		return null;
	}

	const definition = getGraphicDefinition({
		definitionId: element.definitionId,
	});
	const param = definition.params.find((candidate) => candidate.key === paramKey);
	if (!param) {
		return null;
	}

	return buildParamDescriptor({
		param,
		baseParams: element.params,
		setParams: (params) => ({
			...element,
			params,
		}),
	});
}

function buildEffectParamDescriptor({
	element,
	effectId,
	paramKey,
}: {
	element: TimelineElement;
	effectId: string;
	paramKey: string;
}): AnimationPathDescriptor | null {
	if (!isVisualElement(element)) {
		return null;
	}

	const effect = element.effects?.find((candidate) => candidate.id === effectId);
	if (!effect) {
		return null;
	}

	registerDefaultEffects();
	const definition = effectsRegistry.get(effect.type);
	const param = definition.params.find((candidate) => candidate.key === paramKey);
	if (!param) {
		return null;
	}

	return buildParamDescriptor({
		param,
		baseParams: effect.params,
		setParams: (params) => ({
			...element,
			effects:
				element.effects?.map((candidate) =>
					candidate.id !== effectId
						? candidate
						: {
								...candidate,
								params,
							},
				) ?? element.effects,
		}),
	});
}

export function resolveAnimationTarget({
	element,
	path,
}: {
	element: TimelineElement;
	path: AnimationPath;
}): AnimationPathDescriptor | null {
	const elementParamTarget = buildElementParamDescriptor({
		element,
		paramKey: path,
	});
	if (elementParamTarget) {
		return elementParamTarget;
	}

	const graphicParamTarget = parseGraphicParamPath({ propertyPath: path });
	if (graphicParamTarget) {
		return buildGraphicParamDescriptor({
			element,
			paramKey: graphicParamTarget.paramKey,
		});
	}

	const effectParamTarget = parseEffectParamPath({ propertyPath: path });
	if (effectParamTarget) {
		return buildEffectParamDescriptor({
			element,
			effectId: effectParamTarget.effectId,
			paramKey: effectParamTarget.paramKey,
		});
	}

	const maskParamTarget = parseMaskParamPath({ propertyPath: path });
	if (maskParamTarget) {
		return buildMaskParamDescriptor({
			element,
			maskId: maskParamTarget.maskId,
			paramKey: maskParamTarget.paramKey,
		});
	}

	return null;
}

function buildMaskParamDescriptor({
	element,
	maskId,
	paramKey,
}: {
	element: TimelineElement;
	maskId: string;
	paramKey: string;
}): AnimationPathDescriptor | null {
	if (!isMaskableElement(element)) {
		return null;
	}
	const mask = element.masks?.find((candidate) => candidate.id === maskId);
	if (!mask) {
		return null;
	}
	const param = getMaskParamDefinition({ mask, paramKey });
	if (!param) {
		return null;
	}
	// Its values that keyframes can hold: numbers, strings and flags (not a
	// freeform mask's points).
	const baseParams: ParamValues = Object.fromEntries(
		Object.entries(mask.params).flatMap(([key, value]) =>
			typeof value === "number" ||
			typeof value === "string" ||
			typeof value === "boolean"
				? [[key, value]]
				: [],
		),
	);
	return buildParamDescriptor({
		param,
		baseParams,
		setParams: (params) => ({
			...element,
			masks: element.masks?.map((candidate) =>
				candidate.id !== maskId
					? candidate
					: Object.entries(params).reduce(
							(updated, [key, value]) =>
								typeof value === "object"
									? updated
									: withMaskParam({ mask: updated, key, value }),
							candidate,
						),
			),
		}),
	});
}
