import { BaseNode } from "./base-node";
import type { Effect, EffectPass } from "@/effects/types";
import type { Mask } from "@/masks/types";
import type { BlendMode, Transform } from "@/rendering";
import type { RetimeConfig, VisualElement } from "@/timeline";
import type { MediaFile } from "@/media/disk-file";

export interface VisualNodeParams {
	duration: number;
	timeOffset: number;
	trimStart: number;
	trimEnd: number;
	retime?: RetimeConfig;
	transform: Transform;
	animations?: VisualElement["animations"];
	opacity: number;
	blendMode?: BlendMode;
	effects?: Effect[];
	masks?: Mask[];
	/**
	 * When it shows, on the timeline, if not throughout its clip: a
	 * transition's window, or its clip less the transitions at its ends.
	 */
	activeRange?: { start: number; end: number };
}

export interface ResolvedVisualNodeState {
	localTime: number;
	transform: Transform;
	opacity: number;
	effectPasses: EffectPass[][];
	/** As they are now: keyframed masks move. */
	masks?: Mask[];
}

/** A video's frame, by file and time, for an exporter that decodes it itself. */
export interface VideoReference {
	file: MediaFile;
	streamKey?: string;
	/** In the source, in seconds. */
	time: number;
}

export interface ResolvedVisualSourceNodeState extends ResolvedVisualNodeState {
	source: CanvasImageSource;
	sourceWidth: number;
	sourceHeight: number;
	/** Set instead of drawing `source`, for videos left to the exporter. */
	videoReference?: VideoReference;
	/** Which picture `source` holds, where the same object holds others over
	 * time (a decoder's canvases, used in turn): the video frame's time. */
	sourceVersion?: number;
}

export abstract class VisualNode<
	Params extends VisualNodeParams = VisualNodeParams,
	Resolved extends ResolvedVisualNodeState = ResolvedVisualNodeState,
> extends BaseNode<Params, Resolved> {}
