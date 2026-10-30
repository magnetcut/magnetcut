import type { SelectedKeyframeRef } from "@/animation/types";
import type { ElementRef, TransitionRef } from "@/timeline/types";

export interface SelectedMaskPointSelection {
	trackId: string;
	elementId: string;
	maskId: string;
	pointIds: string[];
}

export interface EditorSelectionSnapshot {
	selectedElements: ElementRef[];
	selectedKeyframes: SelectedKeyframeRef[];
	keyframeSelectionAnchor: SelectedKeyframeRef | null;
	selectedMaskPoints: SelectedMaskPointSelection | null;
	selectedTransition: TransitionRef | null;
}

export interface EditorSelectionPatch {
	selectedElements?: ElementRef[];
	selectedKeyframes?: SelectedKeyframeRef[];
	keyframeSelectionAnchor?: SelectedKeyframeRef | null;
	selectedMaskPoints?: SelectedMaskPointSelection | null;
	selectedTransition?: TransitionRef | null;
}

export type EditorSelectionKind =
	| "mask-points"
	| "keyframes"
	| "elements"
	| "transition";
