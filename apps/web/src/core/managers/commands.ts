import type { EditorCore } from "@/core";
import type { Command, CommandResult } from "@/commands";
import type { EditorSelectionSnapshot } from "@/selection/editor-selection";
import { applyRippleAdjustments, computeRippleAdjustments } from "@/ripple";
import { findTrackInSceneTracks } from "@/timeline/track-element-update";
import type { SceneTracks } from "@/timeline/types";

interface CommandHistoryEntry {
	command: Command;
	previousSelection: EditorSelectionSnapshot;
	selectionOverride?: EditorSelectionSnapshot;
	/** Whether it rippled when it was done, so that a redo does the same. */
	rippled?: boolean;
}

/** Where the history was: a mark for `foldSince` and `dropSince`. */
export interface HistoryMark {
	readonly length: number;
	readonly redoStack: readonly CommandHistoryEntry[];
}

export class CommandManager {
	public isRippleEnabled = false;

	/** Whether moves and deletions ripple, as the timeline's toggle says. */
	setRippleEnabled({ enabled }: { enabled: boolean }): void {
		this.isRippleEnabled = enabled;
	}
	private history: CommandHistoryEntry[] = [];
	private redoStack: CommandHistoryEntry[] = [];
	private reactors: Array<() => void> = [];

	constructor(private editor: EditorCore) {}

	execute({ command }: { command: Command }): Command {
		const rippled = this.isRippleEnabled;
		const beforeTracks = rippled
			? (this.editor.scenes.getActiveSceneOrNull()?.tracks ?? null)
			: null;
		const previousSelection = this.getSelectionSnapshot();
		const result = command.execute();
		this.applyRipple({ beforeTracks });
		const selectionOverride = this.applySelectionOverride(result);
		this.runReactors();
		this.deselectGoneTransition();
		this.history.push({
			command,
			previousSelection,
			selectionOverride,
			rippled,
		});
		this.redoStack = [];
		return command;
	}

	push({ command }: { command: Command }): void {
		this.history.push({
			command,
			previousSelection: this.getSelectionSnapshot(),
		});
		this.redoStack = [];
	}

	registerReactor(reactor: () => void): void {
		this.reactors.push(reactor);
	}

	undo(): void {
		if (this.history.length === 0) return;
		const entry = this.history.pop();
		entry?.command.undo();
		if (entry) {
			// Only restore selection for commands that explicitly changed it.
			// Commands without selection intent leave selection untouched,
			// preserving any UI-driven selection changes (clicks, box select)
			// that happened between commands. Commands that remove editor-owned
			// selection targets must declare a selection override to clear stale refs.
			if (entry.selectionOverride !== undefined) {
				this.editor.selection.restoreSnapshot({
					snapshot: entry.previousSelection,
				});
			}
			this.deselectGoneTransition();
			this.redoStack.push(entry);
		}
	}

	redo(): void {
		if (this.redoStack.length === 0) return;
		const entry = this.redoStack.pop();
		if (!entry) {
			return;
		}

		// As it was done, whatever the ripple toggle says now.
		const beforeTracks = entry.rippled
			? (this.editor.scenes.getActiveSceneOrNull()?.tracks ?? null)
			: null;
		const previousSelection = this.getSelectionSnapshot();
		const result = entry.command.redo();
		this.applyRipple({ beforeTracks });
		const selectionOverride = this.applySelectionOverride(result);
		this.runReactors();
		this.deselectGoneTransition();

		this.history.push({
			command: entry.command,
			previousSelection,
			selectionOverride,
			rippled: entry.rippled,
		});
	}

	canUndo(): boolean {
		return this.history.length > 0;
	}

	/** Where the history is now: a mark for `foldSince` or `dropSince`. */
	getHistoryMark(): HistoryMark {
		return { length: this.history.length, redoStack: [...this.redoStack] };
	}

	/** Folds the steps taken since `mark` into one, `command`, already
	 * applied: an agent's batch of edits, one undo. */
	foldSince({ mark, command }: { mark: HistoryMark; command: Command }): void {
		const { length } = mark;
		const first = this.history[length];
		this.history.length = Math.min(this.history.length, length);
		this.history.push({
			command,
			previousSelection:
				first?.previousSelection ?? this.getSelectionSnapshot(),
		});
		this.redoStack = [];
	}

	/** Forgets the steps taken since `mark`, their changes already put back,
	 * and what there was to redo comes back: a dry run, or a batch that
	 * failed. */
	dropSince({ mark }: { mark: HistoryMark }): void {
		this.history.length = Math.min(this.history.length, mark.length);
		this.redoStack = [...mark.redoStack];
	}

	canRedo(): boolean {
		return this.redoStack.length > 0;
	}

	clear(): void {
		this.history = [];
		this.redoStack = [];
	}

	private getSelectionSnapshot(): EditorSelectionSnapshot {
		return this.editor.selection.getSnapshot();
	}

	private applySelectionOverride(
		result: CommandResult | undefined,
	): EditorSelectionSnapshot | undefined {
		if (!result?.selection) {
			return undefined;
		}
		return this.editor.selection.applySelectionPatch({
			patch: result.selection,
		});
	}

	/** Deselects a transition that's no longer on the tracks: a reactor
	 * dropped it, or an undo took it away. */
	private deselectGoneTransition(): void {
		const selected = this.editor.selection.getSelectedTransition();
		if (!selected) {
			return;
		}
		const tracks = this.editor.scenes.getActiveSceneOrNull()?.tracks;
		const track = tracks
			? findTrackInSceneTracks({ tracks, trackId: selected.trackId })
			: null;
		const isThere =
			track?.type === "video" &&
			(track.transitions ?? []).some(
				(transition) => transition.id === selected.transitionId,
			);
		if (!isThere) {
			this.editor.selection.applySelectionPatch({
				patch: { selectedTransition: null },
			});
		}
	}

	private runReactors(): void {
		for (const reactor of this.reactors) {
			reactor();
		}
	}

	/** Closes what the command left open, if it ripples: `beforeTracks` are
	 * the tracks before it, null if it doesn't. */
	private applyRipple({
		beforeTracks,
	}: {
		beforeTracks: SceneTracks | null;
	}): void {
		if (!beforeTracks) {
			return;
		}

		const afterTracks = this.editor.scenes.getActiveSceneOrNull()?.tracks;
		if (!afterTracks) {
			return;
		}
		const adjustments = computeRippleAdjustments({
			beforeTracks,
			afterTracks,
		});
		if (adjustments.length === 0) {
			return;
		}

		const tracksWithRipple = applyRippleAdjustments({
			tracks: afterTracks,
			adjustments,
		});
		this.editor.timeline.updateTracks(tracksWithRipple);
	}
}
