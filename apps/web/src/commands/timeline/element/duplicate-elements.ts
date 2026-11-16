import {
	Command,
	createElementSelectionResult,
	type CommandResult,
} from "@/commands/base-command";
import type { SceneTracks, TimelineElement } from "@/timeline";
import { generateUUID } from "@/utils/id";
import { EditorCore } from "@/core";
import { applyPlacement, resolveTrackPlacement } from "@/timeline/placement";
import { cloneAnimations } from "@/animation";
import type { MediaTime } from "@/wasm";

interface DuplicateElementsParams {
	elements: { trackId: string; elementId: string }[];
}

export class DuplicateElementsCommand extends Command {
	private duplicatedElements: { trackId: string; elementId: string }[] = [];
	private savedState: SceneTracks | null = null;
	private madeState: SceneTracks | null = null;
	private elements: DuplicateElementsParams["elements"];

	constructor({ elements }: DuplicateElementsParams) {
		super();
		this.elements = elements;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;
		this.duplicatedElements = [];

		let updatedTracks = this.savedState;

		for (const track of [
			...this.savedState.overlay,
			this.savedState.main,
			...this.savedState.audio,
		]) {
			const elementsToDuplicate = this.elements.filter(
				(elementEntry) => elementEntry.trackId === track.id,
			);

			if (elementsToDuplicate.length === 0) {
				continue;
			}

			const elementIdsToDuplicate = new Set(
				elementsToDuplicate.map((element) => element.elementId),
			);
			const newTrackElements: TimelineElement[] = [];

			for (const element of track.elements) {
				if (!elementIdsToDuplicate.has(element.id)) {
					continue;
				}

				const newId = generateUUID();
				newTrackElements.push(
					buildDuplicateElement({
						element,
						id: newId,
						startTime: element.startTime,
					}),
				);
			}

			const placementResult = resolveTrackPlacement({
				tracks: updatedTracks,
				trackType: track.type,
				timeSpans: [],
				strategy: { type: "alwaysNew", position: "highest" },
			});
			if (!placementResult || placementResult.kind !== "newTrack") {
				continue;
			}

			const applied = applyPlacement({
				tracks: updatedTracks,
				placementResult,
				elements: newTrackElements,
			});
			if (!applied) {
				continue;
			}

			updatedTracks = applied.updatedTracks;

			for (const element of newTrackElements) {
				this.duplicatedElements.push({
					trackId: applied.targetTrackId,
					elementId: element.id,
				});
			}
		}

		this.madeState = updatedTracks;
		editor.timeline.updateTracks(updatedTracks);
		return this.getSelectionResult();
	}

	undo(): void {
		if (this.savedState) {
			const editor = EditorCore.getInstance();
			editor.timeline.updateTracks(this.savedState);
		}
	}

	/** The copies as the first run made them: the steps after it in the
	 * history refer to their ids. */
	redo(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		if (
			!this.madeState ||
			editor.scenes.getActiveScene().tracks !== this.savedState
		) {
			return this.execute();
		}
		editor.timeline.updateTracks(this.madeState);
		return this.getSelectionResult();
	}

	private getSelectionResult(): CommandResult | undefined {
		if (this.duplicatedElements.length > 0) {
			return createElementSelectionResult(this.duplicatedElements);
		}
		return undefined;
	}

	getDuplicatedElements(): { trackId: string; elementId: string }[] {
		return this.duplicatedElements;
	}
}

function buildDuplicateElement({
	element,
	id,
	startTime,
}: {
	element: TimelineElement;
	id: string;
	startTime: MediaTime;
}): TimelineElement {
	return {
		...element,
		id,
		name: `${element.name} (copy)`,
		startTime,
		animations: cloneAnimations({
			animations: element.animations,
			shouldRegenerateKeyframeIds: true,
		}),
	};
}
