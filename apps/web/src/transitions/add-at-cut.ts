import { toast } from "sonner";
import type { EditorCore } from "@/core";
import { type Cut, findNearestCut } from "./cuts";
import { getDefaultTransitionDuration, getFittingAlignment } from "./timing";

/**
 * Puts a transition of that type at the cut and selects it: the one there
 * changes type, or a new one plays where the clips have media past the cut.
 */
export function addTransitionAtCut({
	editor,
	cut,
	type,
}: {
	editor: EditorCore;
	cut: Cut;
	type?: string;
}): void {
	const track = editor.timeline.getTrackById({ trackId: cut.trackId });
	const existing =
		track?.type === "video"
			? track.transitions?.find(
					(transition) =>
						transition.fromElementId === cut.from.id &&
						transition.toElementId === cut.to.id,
				)
			: undefined;
	if (existing) {
		if (type && type !== existing.type) {
			editor.timeline.updateTransition({
				trackId: cut.trackId,
				transitionId: existing.id,
				changes: { type, params: {} },
			});
		}
		editor.selection.setSelectedTransition({
			transition: { trackId: cut.trackId, transitionId: existing.id },
		});
		return;
	}

	const duration = getDefaultTransitionDuration({
		fps: editor.project.getActive()?.settings.fps,
	});
	const alignment = getFittingAlignment({
		duration,
		from: cut.from,
		to: cut.to,
	});
	if (!alignment) {
		toast.error("No room for a transition at this cut", {
			description:
				"A transition shows what's trimmed off the clips past the cut. Trim the end of the first clip or the start of the second, then try again.",
		});
		return;
	}

	const transitionId = editor.timeline.addTransition({
		trackId: cut.trackId,
		fromElementId: cut.from.id,
		toElementId: cut.to.id,
		type,
		duration,
		alignment,
	});
	editor.selection.setSelectedTransition({
		transition: { trackId: cut.trackId, transitionId },
	});
}

/**
 * Puts a transition at the cut nearest the playhead, among those next to the
 * selected clips if there are any.
 */
export function addTransitionNearPlayhead({
	editor,
	type,
}: {
	editor: EditorCore;
	type?: string;
}): void {
	const selected = editor.selection.getSelectedElements();
	const cut = findNearestCut({
		tracks: editor.scenes.getActiveScene().tracks,
		time: editor.playback.getCurrentTime(),
		elementIds:
			selected.length > 0
				? selected.map(({ elementId }) => elementId)
				: undefined,
	});
	if (!cut) {
		toast.error("No cut for a transition", {
			description:
				"A transition goes where one clip ends and the next starts, on a video track.",
		});
		return;
	}
	addTransitionAtCut({ editor, cut, type });
}
