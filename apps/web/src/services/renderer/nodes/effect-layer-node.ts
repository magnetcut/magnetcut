import type { ElementAnimations } from "@/animation/types";
import type { EffectPass } from "@/effects/types";
import type { Mask } from "@/masks/types";
import type { ParamValues } from "@/params";
import { BaseNode } from "./base-node";

export type EffectLayerNodeParams = {
	effectType: string;
	effectParams: ParamValues;
	timeOffset: number;
	duration: number;
	/** Where it applies, over the whole canvas: everywhere, if none. */
	masks?: Mask[];
	animations?: ElementAnimations;
};

export type ResolvedEffectLayerNodeState = {
	passes: EffectPass[];
	/** As they are now: a Hide region follows what it hides. */
	masks?: Mask[];
};

export class EffectLayerNode extends BaseNode<
	EffectLayerNodeParams,
	ResolvedEffectLayerNodeState
> {}
