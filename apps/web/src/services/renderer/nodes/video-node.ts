import {
	VisualNode,
	type ResolvedVisualSourceNodeState,
	type VisualNodeParams,
} from "./visual-node";
import type { MediaFile } from "@/media/disk-file";

export interface VideoNodeParams extends VisualNodeParams {
	file: MediaFile;
	mediaId: string;
	/**
	 * Which of the file's decoders it takes frames from: clips side by side in
	 * a transition each need their own, even of the same file.
	 */
	streamKey?: string;
}

export class VideoNode extends VisualNode<
	VideoNodeParams,
	ResolvedVisualSourceNodeState
> {}
