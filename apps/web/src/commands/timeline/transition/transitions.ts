import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import {
	updateTrackInSceneTracks,
	type SceneTracks,
	type TimelineTrack,
	type Transition,
	type VideoTrack,
} from "@/timeline";
import { generateUUID } from "@/utils/id";

function isVideoTrack(track: TimelineTrack): track is VideoTrack {
	return track.type === "video";
}

/** A video track's transitions, changed; other tracks have none. */
function updateTransitions({
	tracks,
	trackId,
	update,
}: {
	tracks: SceneTracks;
	trackId: string;
	update: (transitions: Transition[]) => Transition[];
}): SceneTracks {
	return updateTrackInSceneTracks({
		tracks,
		trackId,
		update: (track) =>
			isVideoTrack(track)
				? { ...track, transitions: update(track.transitions ?? []) }
				: track,
	});
}

/** Snapshots the tracks, changes them, and puts the snapshot back on undo. */
abstract class TransitionCommand extends Command {
	private savedState: SceneTracks | null = null;

	protected abstract apply({ tracks }: { tracks: SceneTracks }): SceneTracks;

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;
		editor.timeline.updateTracks(this.apply({ tracks: this.savedState }));
		return undefined;
	}

	undo(): void {
		if (this.savedState) {
			EditorCore.getInstance().timeline.updateTracks(this.savedState);
		}
	}
}

/** Adds a transition at a cut, in place of the one there. */
export class AddTransitionCommand extends TransitionCommand {
	private readonly trackId: string;
	readonly transition: Transition;

	constructor({
		trackId,
		transition,
	}: {
		trackId: string;
		transition: Omit<Transition, "id">;
	}) {
		super();
		this.trackId = trackId;
		this.transition = { ...transition, id: generateUUID() };
	}

	protected apply({ tracks }: { tracks: SceneTracks }): SceneTracks {
		const { fromElementId, toElementId } = this.transition;
		return updateTransitions({
			tracks,
			trackId: this.trackId,
			update: (transitions) => [
				...transitions.filter(
					(transition) =>
						transition.fromElementId !== fromElementId &&
						transition.toElementId !== toElementId,
				),
				this.transition,
			],
		});
	}
}

export class UpdateTransitionCommand extends TransitionCommand {
	private readonly trackId: string;
	private readonly transitionId: string;
	private readonly changes: Partial<Omit<Transition, "id">>;

	constructor({
		trackId,
		transitionId,
		changes,
	}: {
		trackId: string;
		transitionId: string;
		changes: Partial<Omit<Transition, "id">>;
	}) {
		super();
		this.trackId = trackId;
		this.transitionId = transitionId;
		this.changes = changes;
	}

	protected apply({ tracks }: { tracks: SceneTracks }): SceneTracks {
		return updateTransitions({
			tracks,
			trackId: this.trackId,
			update: (transitions) =>
				transitions.map((transition) =>
					transition.id === this.transitionId
						? { ...transition, ...this.changes }
						: transition,
				),
		});
	}
}

export class RemoveTransitionCommand extends TransitionCommand {
	private readonly trackId: string;
	private readonly transitionId: string;

	constructor({
		trackId,
		transitionId,
	}: {
		trackId: string;
		transitionId: string;
	}) {
		super();
		this.trackId = trackId;
		this.transitionId = transitionId;
	}

	protected apply({ tracks }: { tracks: SceneTracks }): SceneTracks {
		return updateTransitions({
			tracks,
			trackId: this.trackId,
			update: (transitions) =>
				transitions.filter((transition) => transition.id !== this.transitionId),
		});
	}
}
