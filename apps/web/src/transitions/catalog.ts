import type { TransitionParamValue } from "@/timeline";

export interface TransitionDefinition {
	/** Kept in projects: never change one. */
	id: string;
	name: string;
	/** The gl-transitions shader that draws it (`rust/crates/compositor`). */
	shader: string;
	/** Its parameters, over the shader's own defaults. */
	params: Record<string, TransitionParamValue>;
}

export const TRANSITIONS: TransitionDefinition[] = [
	{ id: "cross-dissolve", name: "Cross Dissolve", shader: "Fade", params: {} },
	{
		id: "dip-to-black",
		name: "Dip to Black",
		shader: "FadeColor",
		params: { color: [0, 0, 0, 1], colorPhase: 0.5 },
	},
	{
		id: "dip-to-white",
		name: "Dip to White",
		shader: "FadeColor",
		params: { color: [1, 1, 1, 1], colorPhase: 0.5 },
	},
];

export const DEFAULT_TRANSITION_TYPE = "cross-dissolve";

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
