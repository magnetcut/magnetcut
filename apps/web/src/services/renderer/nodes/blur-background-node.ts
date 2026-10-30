import type { EffectPass } from "@/effects/types";
import type { RetimeConfig } from "@/timeline";
import type { MediaFile } from "@/media/disk-file";
import { BaseNode } from "./base-node";

export type BlurBackgroundNodeParams = {
	mediaId: string;
	/** An image's; a video's frames come from its file. */
	url?: string;
	file: MediaFile;
	mediaType: "video" | "image";
	duration: number;
	timeOffset: number;
	trimStart: number;
	trimEnd: number;
	retime?: RetimeConfig;
	blurIntensity: number;
};

export type BackdropSource = {
	source: CanvasImageSource;
	width: number;
	height: number;
};

export interface ResolvedBlurBackgroundNodeState {
	backdropSource: BackdropSource;
	passes: EffectPass[];
}

export class BlurBackgroundNode extends BaseNode<
	BlurBackgroundNodeParams,
	ResolvedBlurBackgroundNodeState
> {}
