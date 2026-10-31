import type { BlendMode } from "@/rendering";
import type { EffectPass } from "@/effects/types";
import type { TransitionParamValue } from "@/timeline";
import type { VideoReference } from "../nodes/visual-node";

export type FrameDescriptor = {
	width: number;
	height: number;
	clear: {
		color: [number, number, number, number];
	};
	items: FrameItemDescriptor[];
};

export type LayerItemDescriptor = {
	type: "layer";
	textureId: string;
	transform: QuadTransformDescriptor;
	opacity: number;
	blendMode: BlendMode;
	effectPassGroups: EffectPass[][];
	/** On the source as it is, before it's placed: Export's filters. */
	sourceEffectPassGroups?: EffectPass[][];
	mask: LayerMaskDescriptor | null;
};

export type FrameItemDescriptor =
	| LayerItemDescriptor
	| {
			type: "sceneEffect";
			effectPassGroups: EffectPass[][];
			/** Only within it, if there is one: a Hide region. */
			mask?: LayerMaskDescriptor | null;
	  }
	| {
			/** Two layers drawn into one (rust/crates/compositor/src/transition.rs). */
			type: "transition";
			/** The outgoing clip: null when it has nothing to show. */
			from: LayerItemDescriptor | null;
			to: LayerItemDescriptor | null;
			/** The gl-transitions shader. */
			transition: string;
			params: Record<string, TransitionParamValue>;
			progress: number;
			blendMode: BlendMode;
	  };

export type QuadTransformDescriptor = {
	centerX: number;
	centerY: number;
	width: number;
	height: number;
	rotationDegrees: number;
	flipX: boolean;
	flipY: boolean;
};

export type LayerMaskDescriptor = {
	textureId: string;
	feather: number;
	inverted: boolean;
};

export type TextureCanvasDrawFn = (
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
) => void;

/**
 * A layer texture whose pixels come from somewhere outside the renderer —
 * typically a decoded video/image frame or a sticker. Cached by reference
 * identity of the source object.
 */
export type ExternalTextureDescriptor = {
	kind: "external";
	id: string;
	source: CanvasImageSource;
	width: number;
	height: number;
	/** Which picture `source` holds, where the same object holds others over
	 * time (a video frame's time): uploaded again when it changes. */
	version?: number;
};

/**
 * A layer texture that the renderer rasterizes from scene state (color fill,
 * text layout, mask shape, blur backdrop). Cached by `contentHash`: when it
 * matches the previous frame's hash for this id, the upload is skipped
 * entirely and the persistent canvas is not even cleared.
 */
export type RenderedTextureDescriptor = {
	kind: "rendered";
	id: string;
	contentHash: string;
	width: number;
	height: number;
	draw: TextureCanvasDrawFn;
};

/**
 * A video's frame that the exporter decodes and uploads itself (the desktop
 * app's native export): only the file and the time are given.
 */
export type VideoTextureDescriptor = {
	kind: "video";
	id: string;
	reference: VideoReference;
	width: number;
	height: number;
};

export type TextureUploadDescriptor =
	| ExternalTextureDescriptor
	| RenderedTextureDescriptor
	| VideoTextureDescriptor;
