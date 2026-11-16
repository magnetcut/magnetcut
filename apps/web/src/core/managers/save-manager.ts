import { toast } from "sonner";
import type { EditorCore } from "@/core";

type SaveManagerOptions = {
	debounceMs?: number;
};

/** The toast that says the project isn't saved: up until a save works. */
export const SAVE_FAILED_TOAST_ID = "save-failed";

export class SaveManager {
	private debounceMs: number;
	private isPaused = false;
	private saving: Promise<void> | null = null;
	private hasPendingSave = false;
	/** The last save failed, and the user was told: once, not at every change. */
	private hasFailed = false;
	private saveTimer: ReturnType<typeof setTimeout> | null = null;
	private unsubscribeHandlers: Array<() => void> = [];

	constructor({
		editor,
		debounceMs = 800,
	}: {
		editor: EditorCore;
	} & SaveManagerOptions) {
		this.editor = editor;
		this.debounceMs = debounceMs;
	}

	private editor: EditorCore;

	start(): void {
		if (this.unsubscribeHandlers.length > 0) return;

		this.unsubscribeHandlers = [
			this.editor.scenes.subscribe(() => {
				this.markDirty();
			}),
			this.editor.timeline.subscribe(() => {
				this.markDirty();
			}),
		];
	}

	stop(): void {
		for (const unsubscribe of this.unsubscribeHandlers) {
			unsubscribe();
		}
		this.unsubscribeHandlers = [];
		this.clearTimer();
	}

	pause(): void {
		this.isPaused = true;
	}

	resume(): void {
		this.isPaused = false;
		if (this.hasPendingSave) {
			this.queueSave();
		}
	}

	markDirty({ force = false }: { force?: boolean } = {}): void {
		if (this.isPaused && !force) return;
		this.hasPendingSave = true;
		this.queueSave();
	}

	/**
	 * Saves the open project now, once any save under way has finished: before
	 * another project opens, the window closes or an update installs. With no
	 * project open, as on the projects page, or one loading, there's nothing to
	 * save. Throws if the save fails, and the changes stay to be saved.
	 */
	async flush(): Promise<void> {
		if (!this.editor.project.getActiveOrNull()) return;
		this.hasPendingSave = true;
		// Whether it works or not; and with no await after the last look, so
		// that no other save starts in between.
		while (this.saving) {
			await this.saving.catch(() => undefined);
		}
		await this.saveNow();
	}

	/**
	 * Forgets the changes not saved yet, once any save under way has finished:
	 * for the open project as it's deleted, which a later save would bring back.
	 * With `pause`, so that none starts meanwhile.
	 */
	async discard(): Promise<void> {
		while (this.saving) {
			await this.saving.catch(() => undefined);
		}
		this.hasPendingSave = false;
		this.clearTimer();
		if (this.hasFailed) {
			this.hasFailed = false;
			toast.dismiss(SAVE_FAILED_TOAST_ID);
		}
	}

	getIsDirty(): boolean {
		return this.hasPendingSave || this.saving !== null;
	}

	private queueSave(): void {
		if (this.saving) return;
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
		}
		this.saveTimer = setTimeout(() => {
			// A failure is told by saveNow, and tried again at the next change.
			this.saveNow().catch(() => undefined);
		}, this.debounceMs);
	}

	private async saveNow(): Promise<void> {
		if (this.saving) return;
		if (!this.hasPendingSave) return;
		// While a project loads, the scenes are another's, or none.
		if (this.isPaused) return;

		if (!this.editor.project.getActiveOrNull()) return;
		if (this.editor.project.getIsLoading()) return;
		if (this.editor.project.getMigrationState().isMigrating) return;

		this.hasPendingSave = false;
		this.clearTimer();

		this.saving = this.editor.project.saveCurrentProject();
		try {
			await this.saving;
			if (this.hasFailed) {
				this.hasFailed = false;
				toast.dismiss(SAVE_FAILED_TOAST_ID);
			}
		} catch (error) {
			// Still to save: the next change, or a flush, tries again.
			this.hasPendingSave = true;
			if (!this.hasFailed) {
				this.hasFailed = true;
				toast.error("Couldn't save the project", {
					id: SAVE_FAILED_TOAST_ID,
					description: error instanceof Error ? error.message : String(error),
					duration: Number.POSITIVE_INFINITY,
				});
			}
			throw error;
		} finally {
			this.saving = null;
			if (this.hasPendingSave && !this.hasFailed) {
				this.queueSave();
			}
		}
	}

	private clearTimer(): void {
		if (!this.saveTimer) return;
		clearTimeout(this.saveTimer);
		this.saveTimer = null;
	}
}
