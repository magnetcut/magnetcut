import type { TransitionParamValue } from "@/timeline";

/** How the inspector offers one of a shader's parameters. */
export interface TransitionParamControl {
	/** Not offered: the type sets it. */
	hidden?: boolean;
	label?: string;
	min?: number;
	max?: number;
	step?: number;
	/** Choices, offered as a list: for a number or a vector. */
	options?: { value: TransitionParamValue; label: string }[];
}

export interface TransitionDefinition {
	/** Kept in projects: never change one. */
	id: string;
	name: string;
	/** The gl-transitions shader that draws it (`rust/crates/compositor`). */
	shader: string;
	/** Its parameters, over the shader's own defaults. */
	params: Record<string, TransitionParamValue>;
	/** By parameter name; one not here is offered as the shader describes it. */
	controls?: Record<string, TransitionParamControl>;
}

// The way a wipe travels, in the shaders' coordinates: y grows upward.
const DIRECTIONS: TransitionParamControl["options"] = [
	{ value: [1, 0], label: "Right" },
	{ value: [-1, 0], label: "Left" },
	{ value: [0, 1], label: "Up" },
	{ value: [0, -1], label: "Down" },
	{ value: [1, 1], label: "Up and right" },
	{ value: [-1, 1], label: "Up and left" },
	{ value: [1, -1], label: "Down and right" },
	{ value: [-1, -1], label: "Down and left" },
];

// Where Slides shrinks the outgoing clip to, or grows the incoming one from.
const SLIDE_PLACES: TransitionParamControl["options"] = [
	{ value: 0, label: "Top" },
	{ value: 1, label: "Right" },
	{ value: 2, label: "Bottom" },
	{ value: 3, label: "Left" },
	{ value: 4, label: "Top right" },
	{ value: 5, label: "Bottom right" },
	{ value: 6, label: "Bottom left" },
	{ value: 7, label: "Top left" },
	{ value: 8, label: "Center" },
];

const SOFTNESS: TransitionParamControl = {
	label: "Softness",
	min: 0,
	max: 1,
	step: 0.01,
};

const DIP: Record<string, TransitionParamControl> = {
	color: { hidden: true },
	colorPhase: { label: "Hold" },
};

export const TRANSITIONS: TransitionDefinition[] = [
	{ id: "cross-dissolve", name: "Cross Dissolve", shader: "Fade", params: {} },
	{
		id: "dip-to-black",
		name: "Dip to Black",
		shader: "FadeColor",
		params: { color: [0, 0, 0, 1], colorPhase: 0.5 },
		controls: DIP,
	},
	{
		id: "dip-to-white",
		name: "Dip to White",
		shader: "FadeColor",
		params: { color: [1, 1, 1, 1], colorPhase: 0.5 },
		controls: DIP,
	},
	{
		id: "grayscale-dissolve",
		name: "Grayscale Dissolve",
		shader: "FadeGrayscale",
		params: {},
		controls: { intensity: { label: "Gray phase" } },
	},
	{ id: "wipe-left", name: "Wipe Left", shader: "WipeLeft", params: {} },
	{ id: "wipe-right", name: "Wipe Right", shader: "WipeRight", params: {} },
	{ id: "wipe-up", name: "Wipe Up", shader: "WipeUp", params: {} },
	{ id: "wipe-down", name: "Wipe Down", shader: "WipeDown", params: {} },
	{
		id: "soft-wipe",
		name: "Soft Wipe",
		shader: "DirectionalWipe",
		params: {},
		controls: {
			direction: { label: "Direction", options: DIRECTIONS },
			smoothness: SOFTNESS,
		},
	},
	{
		id: "warp-wipe",
		name: "Warp Wipe",
		shader: "DirectionalWarp",
		params: {},
		controls: {
			direction: { label: "Direction", options: DIRECTIONS },
			smoothness: SOFTNESS,
		},
	},
	{
		id: "iris",
		name: "Iris",
		shader: "CircleOpen",
		params: {},
		controls: { smoothness: SOFTNESS, opening: { label: "Open" } },
	},
	{
		id: "zoom",
		name: "Zoom",
		shader: "SimpleZoom",
		params: {},
		controls: { zoom_quickness: { label: "Zoom part" } },
	},
	{
		id: "shrink",
		name: "Shrink",
		shader: "Slides",
		params: { type: 8, In: false },
		controls: {
			type: { label: "Toward", options: SLIDE_PLACES },
			In: { hidden: true },
		},
	},
	{
		id: "grow",
		name: "Grow",
		shader: "Slides",
		params: { type: 8, In: true },
		controls: {
			type: { label: "From", options: SLIDE_PLACES },
			In: { hidden: true },
		},
	},
];

export const DEFAULT_TRANSITION_TYPE = "cross-dissolve";

/** How long a new transition lasts, before rounding to frames. */
export const DEFAULT_TRANSITION_SECONDS = 0.5;

/** A transition type: the cross-dissolve for one this version doesn't know. */
export function getTransitionDefinition({
	type,
}: {
	type: string;
}): TransitionDefinition {
	return (
		TRANSITIONS.find((definition) => definition.id === type) ?? TRANSITIONS[0]
	);
}
