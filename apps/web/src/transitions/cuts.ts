import type {
	ImageElement,
	SceneTracks,
	VideoElement,
	VideoTrack,
} from "@/timeline";
import type { MediaTime } from "@/wasm";

export interface Cut {
	trackId: string;
	/** Where one clip ends and the next starts. */
	time: MediaTime;
	from: VideoElement | ImageElement;
	to: VideoElement | ImageElement;
}

/** The places on a video track where one clip ends and the next starts. */
export function getTrackCuts({ track }: { track: VideoTrack }): Cut[] {
	const elements = [...track.elements].sort(
		(a, b) => a.startTime - b.startTime,
	);
	const cuts: Cut[] = [];
	for (let index = 1; index < elements.length; index++) {
		const from = elements[index - 1];
		const to = elements[index];
		if (from.startTime + from.duration === to.startTime) {
			cuts.push({ trackId: track.id, time: to.startTime, from, to });
		}
	}
	return cuts;
}

/**
 * The cut nearest that time on any video track, the main one first; with
 * elements, only the cuts on either side of them.
 */
export function findNearestCut({
	tracks,
	time,
	elementIds,
}: {
	tracks: SceneTracks;
	time: MediaTime;
	elementIds?: string[];
}): Cut | null {
	const videoTracks = [tracks.main, ...tracks.overlay].filter(
		(track): track is VideoTrack => track.type === "video",
	);
	let nearest: Cut | null = null;
	for (const track of videoTracks) {
		for (const cut of getTrackCuts({ track })) {
			const touches =
				!elementIds ||
				elementIds.includes(cut.from.id) ||
				elementIds.includes(cut.to.id);
			if (!touches) continue;
			if (
				!nearest ||
				Math.abs(cut.time - time) < Math.abs(nearest.time - time)
			) {
				nearest = cut;
			}
		}
	}
	return nearest;
}
