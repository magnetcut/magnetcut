import type { BlendMode } from "@/rendering";
import type { TransitionParamValue } from "@/timeline";
import type { TransitionWindow } from "@/transitions";
import { BaseNode, type AnyBaseNode } from "./base-node";

export interface TransitionNodeParams {
	/** The gl-transitions shader that draws it. */
	shader: string;
	params: Record<string, TransitionParamValue>;
	window: TransitionWindow;
	blendMode?: BlendMode;
}

export interface ResolvedTransitionNodeState {
	progress: number;
}

/**
 * Two clips' nodes, drawn into one across the transition's window. Each shows
 * only there: before and after, the clips' own nodes do.
 */
export class TransitionNode extends BaseNode<
	TransitionNodeParams,
	ResolvedTransitionNodeState
> {
	readonly from: AnyBaseNode | null;
	readonly to: AnyBaseNode | null;

	constructor({
		from,
		to,
		...params
	}: TransitionNodeParams & {
		from: AnyBaseNode | null;
		to: AnyBaseNode | null;
	}) {
		super(params);
		this.from = from;
		this.to = to;
		for (const node of [from, to]) {
			if (node) {
				this.add(node);
			}
		}
	}
}
