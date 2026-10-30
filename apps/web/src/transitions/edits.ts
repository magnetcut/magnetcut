import type { SceneTracks, Transition, VideoTrack } from "@/timeline";

/**
 * Every video track's transitions, each kept, changed or dropped (null). The
 * same tracks object when nothing changed.
 */
export function mapTransitions({
	tracks,
	map,
}: {
	tracks: SceneTracks;
	map: ({
		transition,
		track,
	}: {
		transition: Transition;
		track: VideoTrack;
	}) => Transition | null;
}): SceneTracks {
	const mapTrack = (track: VideoTrack): VideoTrack => {
		if (!track.transitions?.length) return track;
		let changed = false;
		const transitions = track.transitions.flatMap((transition) => {
			const next = map({ transition, track });
			if (next !== transition) changed = true;
			return next ? [next] : [];
		});
		return changed ? { ...track, transitions } : track;
	};

	const main = mapTrack(tracks.main);
	const overlay = tracks.overlay.map((track) =>
		track.type === "video" ? mapTrack(track) : track,
	);
	const changed =
		main !== tracks.main ||
		overlay.some((track, index) => track !== tracks.overlay[index]);
	return changed ? { ...tracks, main, overlay } : tracks;
}

/**
 * Without the transitions that no longer have their two clips touching on
 * their track (deleted, moved, trimmed apart), or that another at the same cut
 * replaced. A transition too long for the handles left stays as it is: it
 * plays shortened, and whole again if the handles come back.
 */
export function dropBrokenTransitions({
	tracks,
}: {
	tracks: SceneTracks;
}): SceneTracks {
	return mapTransitions({
		tracks,
		map: ({ transition, track }) => {
			const from = track.elements.find(
				(element) => element.id === transition.fromElementId,
			);
			const to = track.elements.find(
				(element) => element.id === transition.toElementId,
			);
			const touching =
				from && to && from.startTime + from.duration === to.startTime;
			// The last one at a cut wins.
			const last = track.transitions?.findLast(
				(other) =>
					other.fromElementId === transition.fromElementId ||
					other.toElementId === transition.toElementId,
			);
			return touching && last === transition ? transition : null;
		},
	});
}

/**
 * After a split, the transitions at the split clips' ends move to the halves
 * that now end there: `ends` maps each split clip's id to its right half's.
 */
export function followSplitEnds({
	tracks,
	ends,
}: {
	tracks: SceneTracks;
	ends: ReadonlyMap<string, string>;
}): SceneTracks {
	if (ends.size === 0) return tracks;
	return mapTransitions({
		tracks,
		map: ({ transition }) => {
			const fromElementId = ends.get(transition.fromElementId);
			return fromElementId ? { ...transition, fromElementId } : transition;
		},
	});
}
