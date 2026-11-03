import { getSinkKey, videoCache } from "@/services/video-cache/service";
import { TICKS_PER_SECOND } from "@/wasm";
import type { AnyBaseNode } from "./nodes/base-node";
import { VideoNode } from "./nodes/video-node";
import { getVideoSourceTime } from "./resolve";

/**
 * How far ahead of the playhead a clip's decoder is opened and sought, in
 * seconds: longer than decoding a group of pictures takes, and a screen
 * recording's keyframes can be 6 s apart. A preview that waited until the
 * clip came would play past a transition's half second before its first frame.
 */
const WARM_UP_SECONDS = 3;

export interface VideoWarmUp {
	node: VideoNode;
	/** Its decoder, as the video cache keys them. */
	sinkKey: string;
	/** When it comes, on the timeline. */
	start: number;
}

function collectVideoNodes({
	node,
	into,
}: {
	node: AnyBaseNode;
	into: VideoNode[];
}): VideoNode[] {
	if (node instanceof VideoNode) {
		into.push(node);
	}
	for (const child of node.children) {
		collectVideoNodes({ node: child, into });
	}
	return into;
}

/**
 * The videos that start within `lookahead` of `time` and whose decoders no
 * clip shows from until then: seeking those ahead takes nothing from the clips
 * playing. A transition's incoming side is one; its outgoing side goes on with
 * the decoder its clip already plays from.
 */
export function findVideoWarmUps({
	root,
	time,
	lookahead,
}: {
	root: AnyBaseNode;
	time: number;
	lookahead: number;
}): VideoWarmUp[] {
	const videos = collectVideoNodes({ node: root, into: [] }).map((node) => {
		const { activeRange, timeOffset, duration, mediaId, streamKey } =
			node.params;
		return {
			node,
			sinkKey: getSinkKey({ mediaId, streamKey }),
			start: activeRange?.start ?? timeOffset,
			end: activeRange?.end ?? timeOffset + duration,
		};
	});
	return videos
		.filter(({ start }) => start > time && start <= time + lookahead)
		.filter(
			(video) =>
				!videos.some(
					(other) =>
						other !== video &&
						other.sinkKey === video.sinkKey &&
						other.start < video.start &&
						other.end > time,
				),
		)
		.map(({ node, sinkKey, start }) => ({ node, sinkKey, start }));
}

const warmed = new WeakMap<
	AnyBaseNode,
	{ time: number; started: Set<string> }
>();

/**
 * While the preview plays: seeks the decoders of the videos coming up, each
 * once, so that its first frame is ready when it comes.
 */
export function warmUpcomingVideos({
	root,
	time,
}: {
	root: AnyBaseNode;
	time: number;
}): void {
	const lookahead = WARM_UP_SECONDS * TICKS_PER_SECOND;
	let state = warmed.get(root);
	// Played again from earlier, or from further on: the decoders have moved.
	if (!state || time < state.time || time > state.time + lookahead) {
		state = { time, started: new Set() };
		warmed.set(root, state);
	}
	state.time = time;

	for (const { node, sinkKey, start } of findVideoWarmUps({
		root,
		time,
		lookahead,
	})) {
		const id = `${sinkKey}@${start}`;
		if (state.started.has(id)) {
			continue;
		}
		state.started.add(id);
		videoCache
			.getFrameAt({
				mediaId: node.params.mediaId,
				file: node.params.file,
				time: getVideoSourceTime({ params: node.params, time: start }),
				streamKey: node.params.streamKey,
			})
			// The render asks again when the clip comes, and reports there.
			.catch(() => {});
	}
}
