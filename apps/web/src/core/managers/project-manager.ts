import type { EditorCore } from "@/core";
import type {
	TProject,
	TProjectMetadata,
	TProjectSortKey,
	TProjectSortOption,
	TProjectSettings,
	TTimelineViewState,
} from "@/project/types";
import type { ExportOptions, ExportResult, ExportState } from "@/export";
import { normalizeFileTags, type FileTags } from "@/project/file-tags";
import { storageService } from "@/services/storage/service";
import { toast } from "sonner";
import { generateUUID } from "@/utils/id";
import { UpdateProjectSettingsCommand } from "@/commands/project";
import { DEFAULT_BACKGROUND_COLOR } from "@/background/color";
import { DEFAULT_CANVAS_SIZE } from "@/canvas/sizes";
import { DEFAULT_FPS } from "@/fps/defaults";
import { buildDefaultScene, getProjectDurationFromScenes } from "@/timeline/scenes";
import {
	CURRENT_PROJECT_VERSION,
	migrations,
	runStorageMigrations,
	type MigrationProgress,
} from "@/services/storage/migrations";
import { loadFonts } from "@/fonts/google-fonts";
import { DEFAULTS } from "@/timeline/defaults";
import { getElementFontFamilies } from "@/timeline/element-utils";
import { getRaisedProjectFpsForImportedMedia } from "@/fps/utils";
import type { MediaAsset } from "@/media/types";

/** How an export ended, told to whatever listens (`onExportEnd`): the
 * desktop app's notification, say. */
export interface ExportEnd {
	result: ExportResult;
	/** The project's name as the export started. */
	name: string;
	/** How long it took, in seconds. */
	seconds: number;
}

export interface MigrationState {
	isMigrating: boolean;
	fromVersion: number | null;
	toVersion: number | null;
	projectName: string | null;
}

export class ProjectManager {
	private active: TProject | null = null;
	private savedProjects: TProjectMetadata[] = [];
	private isLoading = true;
	private isInitialized = false;
	/** The project whose load has finished, media and fonts in: what an agent
	 * waits for after opening one (src/agent). */
	private loadedProjectId: string | null = null;
	/** The last load, if it failed: what the editor shows instead. */
	private loadError: { projectId: string; message: string } | null = null;
	private invalidProjectIds = new Set<string>();
	private storageMigrationPromise: Promise<void> | null = null;
	private listeners = new Set<() => void>();
	private migrationState: MigrationState = {
		isMigrating: false,
		fromVersion: null,
		toVersion: null,
		projectName: null,
	};
	private exportState: ExportState = {
		isExporting: false,
		progress: 0,
		result: null,
	};
	private exportCancelRequested = false;
	/** The export under way: one at a time, the panel's or an agent's. */
	private runningExport: Promise<ExportResult> | null = null;
	private exportEndListeners = new Set<(end: ExportEnd) => void>();

	constructor(private editor: EditorCore) {}

	private async ensureStorageMigrations(): Promise<void> {
		if (this.storageMigrationPromise) {
			await this.storageMigrationPromise;
			return;
		}

		this.storageMigrationPromise = (async () => {
			await runStorageMigrations({
				migrations,
				onProgress: (progress: MigrationProgress) => {
					this.migrationState = progress;
					this.notify();
				},
			});
		})();

		await this.storageMigrationPromise;
	}

	async createNewProject({ name }: { name: string }): Promise<string> {
		// The open project's last changes are saved before it's replaced, and
		// its undo history goes with it; an export of it stops first.
		await this.stopExport();
		await this.editor.save.flush();
		this.editor.command.clear();
		const mainScene = buildDefaultScene({ name: "Main scene", isMain: true });
		const newProject: TProject = {
			metadata: {
				id: generateUUID(),
				name,
				duration: getProjectDurationFromScenes({ scenes: [mainScene] }),
				createdAt: new Date(),
				updatedAt: new Date(),
			},
			scenes: [mainScene],
			currentSceneId: mainScene.id,
			settings: {
				fps: DEFAULT_FPS,
				canvasSize: DEFAULT_CANVAS_SIZE,
				canvasSizeMode: "preset",
				lastCustomCanvasSize: null,
				originalCanvasSize: null,
				background: {
					type: "color",
					color: DEFAULT_BACKGROUND_COLOR,
				},
			},
			version: CURRENT_PROJECT_VERSION,
		};

		this.active = newProject;
		this.notify();

		this.editor.media.clearAllAssets();
		this.editor.scenes.initializeScenes({
			scenes: newProject.scenes,
			currentSceneId: newProject.currentSceneId,
		});

		try {
			await storageService.saveProject({ project: newProject });
			this.updateMetadata(newProject);

			return newProject.metadata.id;
		} catch (error) {
			toast.error("Failed to save new project");
			throw error;
		}
	}

	async loadProject({ id }: { id: string }): Promise<void> {
		this.loadError = null;
		// An export of the open project reads its media, which goes: it stops
		// first.
		await this.stopExport();
		// The open project's last changes are saved before its scenes go: if
		// they can't be, nothing goes.
		try {
			await this.editor.save.flush();
		} catch (error) {
			const failure = new Error(
				`Couldn't save the open project first: ${error instanceof Error ? error.message : String(error)}`,
			);
			this.loadError = { projectId: id, message: failure.message };
			this.notify();
			throw failure;
		}

		if (!this.isInitialized) {
			this.isLoading = true;
			this.notify();
		}

		this.loadedProjectId = null;
		this.editor.save.pause();

		try {
			await this.ensureStorageMigrations();
			// Its undo would put the old project's tracks into the new one.
			this.editor.command.clear();
			this.editor.media.clearAllAssets();
			this.editor.scenes.clearScenes();

			const result = await storageService.loadProject({ id });
			if (!result) {
				throw new Error(`Project with id ${id} not found`);
			}

			const project = result.project;

			this.active = project;
			this.notify();

			if (project.scenes && project.scenes.length > 0) {
				this.editor.scenes.initializeScenes({
					scenes: project.scenes,
					currentSceneId: project.currentSceneId,
				});
			}

			await this.editor.media.loadProjectMedia({ projectId: id });

			await loadFonts({
				families: [
					...new Set(
						(project.scenes ?? []).flatMap((scene) =>
							getElementFontFamilies({ tracks: scene.tracks }),
						),
					),
				],
			});

			this.loadedProjectId = id;

			if (!project.metadata.thumbnail) {
				try {
					const didUpdateThumbnail = await this.editor.thumbnail.refresh();
					if (didUpdateThumbnail) {
						await this.saveCurrentProject();
					}
				} catch (error) {
					console.error("Failed to generate project thumbnail:", error);
				}
			}
		} catch (error) {
			console.error("Failed to load project:", error);
			this.loadError = {
				projectId: id,
				message: error instanceof Error ? error.message : String(error),
			};
			throw error;
		} finally {
			this.isLoading = false;
			this.notify();
			this.editor.save.resume();
		}
	}

	async saveCurrentProject(): Promise<void> {
		const saved = this.active;
		if (!saved) return;

		try {
			const scenes = this.editor.scenes.getScenes();
			const updatedProject = {
				...saved,
				scenes,
				metadata: {
					...saved.metadata,
					duration: getProjectDurationFromScenes({ scenes }),
					updatedAt: new Date(),
				},
			};

			await storageService.saveProject({ project: updatedProject });
			// Closed or deleted while it saved: it isn't brought back. Changed
			// while it saved (its details, say): the change stays, for the save
			// it asked for, rather than this older copy.
			if (this.active !== saved) return;
			this.active = updatedProject;
			this.updateMetadata(updatedProject);
		} catch (error) {
			console.error("Failed to save project:", error);
			throw error;
		}
	}

	/**
	 * Makes an export: one at a time, the panel's or an agent's, another
	 * refused while it runs. Its state says how far it's got and how it ended;
	 * whatever listens is told it ended (`onExportEnd`).
	 */
	async export({ options }: { options: ExportOptions }): Promise<ExportResult> {
		if (this.runningExport) {
			return {
				success: false,
				error: "Another export is running: wait for it to end, or cancel it",
			};
		}
		const running = this.runExport({ options });
		this.runningExport = running;
		try {
			return await running;
		} finally {
			this.runningExport = null;
		}
	}

	private async runExport({
		options,
	}: {
		options: ExportOptions;
	}): Promise<ExportResult> {
		this.exportCancelRequested = false;
		const startedAt = Date.now();
		const name = this.active?.metadata.name ?? "The film";
		this.exportState = {
			isExporting: true,
			progress: 0,
			result: null,
			startedAt,
		};
		this.notify();

		let result: ExportResult;
		try {
			result = await this.editor.renderer.exportProject({
				options,
				onProgress: ({ progress }) => {
					this.exportState = { ...this.exportState, progress };
					this.notify();
				},
				onCancel: () => this.exportCancelRequested,
			});
		} catch (error) {
			// Ended all the same: never left running.
			result = {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}

		this.exportState = {
			isExporting: false,
			progress: this.exportState.progress,
			result,
		};
		this.notify();
		const end: ExportEnd = {
			result,
			name,
			seconds: (Date.now() - startedAt) / 1000,
		};
		for (const listener of this.exportEndListeners) {
			try {
				listener(end);
			} catch (error) {
				console.error("Couldn't say the export ended:", error);
			}
		}
		return result;
	}

	/** Calls `listener` as each export ends, until the function returned is
	 * called. */
	onExportEnd(listener: (end: ExportEnd) => void): () => void {
		this.exportEndListeners.add(listener);
		return () => {
			this.exportEndListeners.delete(listener);
		};
	}

	/** Cancels the export under way, if there's one, and waits for it to end:
	 * before what it reads (the project, its media) goes. */
	async stopExport(): Promise<void> {
		const running = this.runningExport;
		if (!running) return;
		this.exportCancelRequested = true;
		await running.catch(() => undefined);
	}

	/**
	 * The details of the project `projectId`, written into its exports, if
	 * it's still the one open: saved as its other changes are.
	 */
	setFileTags({
		projectId,
		tags,
	}: {
		projectId: string;
		tags: FileTags;
	}): void {
		if (this.active?.metadata.id !== projectId) return;
		this.active = {
			...this.active,
			metadata: {
				...this.active.metadata,
				tags: normalizeFileTags({ raw: tags }),
			},
		};
		this.notify();
		this.editor.save.markDirty();
	}

	cancelExport(): void {
		this.exportCancelRequested = true;
	}

	/** Forgets how the last export ended: not while one runs, whose progress
	 * is still being said. */
	clearExportState(): void {
		if (this.runningExport) return;
		this.exportState = { isExporting: false, progress: 0, result: null };
		this.notify();
	}

	getExportState(): ExportState {
		return this.exportState;
	}

	async loadAllProjects(): Promise<void> {
		if (!this.isInitialized) {
			this.isLoading = true;
			this.notify();
		}

		try {
			await this.ensureStorageMigrations();
			try {
				const metadata = await storageService.loadAllProjectsMetadata();
				this.savedProjects = metadata;
				this.notify();
			} catch (error) {
				console.error("Failed to load projects:", error);
			} finally {
				this.isLoading = false;
				this.isInitialized = true;
				this.notify();
			}
		} catch (error) {
			console.error("Failed to run migrations:", error);
			this.isLoading = false;
			this.isInitialized = true;
			this.notify();
		}
	}

	async deleteProjects({ ids }: { ids: string[] }): Promise<void> {
		const uniqueIds = Array.from(new Set(ids));
		if (uniqueIds.length === 0) return;

		const idSet = new Set(uniqueIds);
		// The open project, if it goes, isn't saved again: a save after the
		// delete would bring it back.
		const deletesActive =
			this.active !== null && idSet.has(this.active.metadata.id);
		if (deletesActive) {
			// An export of it reads its media, which goes too.
			await this.stopExport();
			this.editor.save.pause();
			await this.editor.save.discard();
		}

		try {
			await Promise.all(
				uniqueIds.map((id) =>
					Promise.all([
						storageService.deleteProjectMedia({ projectId: id }),
						storageService.deleteProject({ id }),
					]),
				),
			);

			this.savedProjects = this.savedProjects.filter(
				(project) => !idSet.has(project.id),
			);

			const shouldClearActive =
				this.active && idSet.has(this.active.metadata.id);

			if (shouldClearActive) {
				this.active = null;
				this.editor.command.clear();
				this.editor.media.clearAllAssets();
				this.editor.scenes.clearScenes();
			}

			this.notify();
		} catch (error) {
			console.error("Failed to delete projects:", error);
		} finally {
			if (deletesActive) this.editor.save.resume();
		}
	}

	/** Closes the open project: an export of it is stopped first, with
	 * `stopExport`; one still running is told to stop at its next frame. */
	closeProject(): void {
		if (this.runningExport) this.exportCancelRequested = true;
		this.active = null;
		this.notify();

		this.editor.command.clear();
		this.editor.media.clearAllAssets();
		this.editor.scenes.clearScenes();
	}

	async renameProject({
		id,
		name,
	}: {
		id: string;
		name: string;
	}): Promise<void> {
		try {
			const result = await storageService.loadProject({ id });
			if (!result) {
				toast.error("Project not found", {
					description: "Please try again",
				});
				return;
			}

			const updatedProject: TProject = {
				...result.project,
				metadata: {
					...result.project.metadata,
					name,
					updatedAt: new Date(),
				},
			};

			await storageService.saveProject({ project: updatedProject });

			if (this.active?.metadata.id === id) {
				this.active = updatedProject;
				this.notify();
			}

			this.updateMetadata(updatedProject);
		} catch (error) {
			console.error("Failed to rename project:", error);
			toast.error("Failed to rename project", {
				description:
					error instanceof Error ? error.message : "Please try again",
			});
		}
	}

	async duplicateProjects({ ids }: { ids: string[] }): Promise<string[]> {
		const uniqueIds = Array.from(new Set(ids));
		if (uniqueIds.length === 0) return [];

		try {
			const getDuplicateBaseName = ({ name }: { name: string }) => {
				const match = name.match(/^\((\d+)\)\s+(.+)$/);
				const number = match ? Number.parseInt(match[1], 10) : null;
				const baseName = match ? match[2] : name;
				return { baseName, number };
			};

			const loadResults = await Promise.all(
				uniqueIds.map(async (projectId) => {
					const result = await storageService.loadProject({ id: projectId });
					return { projectId, project: result?.project ?? null };
				}),
			);

			const missingProjectIds = loadResults
				.filter((result) => !result.project)
				.map((result) => result.projectId);

			if (missingProjectIds.length > 0) {
				toast.error(
					missingProjectIds.length === 1
						? "Project not found"
						: "Projects not found",
					{
						description:
							missingProjectIds.length === 1
								? "Please try again"
								: "Some projects could not be found",
					},
				);
				throw new Error(`Projects not found: ${missingProjectIds.join(", ")}`);
			}

			const projectsToDuplicate = loadResults.flatMap((result) =>
				result.project ? [result.project] : [],
			);

			const maxNumberByBaseName = new Map<string, number>();

			for (const project of this.savedProjects) {
				const { baseName, number } = getDuplicateBaseName({
					name: project.name,
				});

				if (number === null) continue;

				const currentMax = maxNumberByBaseName.get(baseName);
				if (currentMax === undefined || number > currentMax) {
					maxNumberByBaseName.set(baseName, number);
				}
			}

			const nextNumberByBaseName = new Map<string, number>();
			for (const [baseName, maxNumber] of maxNumberByBaseName) {
				nextNumberByBaseName.set(baseName, maxNumber + 1);
			}

			const duplicationPlans = projectsToDuplicate.map((project) => {
				const { baseName } = getDuplicateBaseName({
					name: project.metadata.name,
				});
				const nextNumber = nextNumberByBaseName.get(baseName) ?? 1;
				nextNumberByBaseName.set(baseName, nextNumber + 1);

				const newProjectId = generateUUID();
				const newProject: TProject = {
					...project,
					metadata: {
						...project.metadata,
						id: newProjectId,
						name: `(${nextNumber}) ${baseName}`,
						createdAt: new Date(),
						updatedAt: new Date(),
					},
				};

				return {
					newProjectId,
					newProject,
					sourceProjectId: project.metadata.id,
				};
			});

			await Promise.all(
				duplicationPlans.map(({ newProject }) =>
					storageService.saveProject({ project: newProject }),
				),
			);

			// As stored: files on disk that have gone stay named, to be found.
			await Promise.all(
				duplicationPlans.map(({ sourceProjectId, newProjectId }) =>
					storageService.copyProjectMedia({
						fromProjectId: sourceProjectId,
						toProjectId: newProjectId,
					}),
				),
			);

			for (const { newProject } of duplicationPlans) {
				this.updateMetadata(newProject);
			}

			return duplicationPlans.map((plan) => plan.newProjectId);
		} catch (error) {
			console.error("Failed to duplicate projects:", error);
			toast.error("Failed to duplicate projects", {
				description:
					error instanceof Error ? error.message : "Please try again",
			});
			throw error;
		}
	}

	async updateSettings({
		settings,
		pushHistory = true,
	}: {
		settings: Partial<TProjectSettings>;
		pushHistory?: boolean;
	}): Promise<void> {
		if (!this.active) return;

		const command = new UpdateProjectSettingsCommand(settings);
		if (pushHistory) {
			this.editor.command.execute({ command });
			return;
		}

		command.execute();
	}

	ratchetFpsForImportedMedia({
		importedAssets,
	}: {
		importedAssets: Array<Pick<MediaAsset, "type" | "fps">>;
	}): import("magnetcut-wasm").FrameRate | null {
		if (!this.active) return null;

		const nextFps = getRaisedProjectFpsForImportedMedia({
			currentFps: this.active.settings.fps,
			importedAssets,
		});
		if (nextFps === null) return null;

		new UpdateProjectSettingsCommand({ fps: nextFps }).execute();
		return nextFps;
	}

	/** None for an empty timeline: the projects page shows a placeholder. */
	async updateThumbnail({
		thumbnail,
	}: {
		thumbnail: string | undefined;
	}): Promise<void> {
		if (!this.active) return;

		const updatedProject: TProject = {
			...this.active,
			metadata: { ...this.active.metadata, thumbnail, updatedAt: new Date() },
		};
		this.active = updatedProject;
		this.notify();
		this.updateMetadata(updatedProject);
		this.editor.save.markDirty();
	}

	/** Saves the open project, with a new thumbnail: throws if it can't. */
	async prepareExit(): Promise<void> {
		if (!this.active) return;

		try {
			await this.editor.thumbnail.refresh();
		} catch (error) {
			console.error("Failed to generate project thumbnail on exit:", error);
		}
		await this.editor.save.flush();
	}

	getFilteredAndSortedProjects({
		searchQuery,
		sortOption,
	}: {
		searchQuery: string;
		sortOption: TProjectSortOption;
	}): TProjectMetadata[] {
		const filteredProjects = this.savedProjects.filter((project) =>
			project.name.toLowerCase().includes(searchQuery.toLowerCase()),
		);

		const [key, order] = sortOption.split("-") as [
			TProjectSortKey,
			"asc" | "desc",
		];

		const sortedProjects = [...filteredProjects].sort((a, b) => {
			const aValue = a[key];
			const bValue = b[key];

			if (order === "asc") {
				if (aValue < bValue) return -1;
				if (aValue > bValue) return 1;
				return 0;
			}
			if (aValue > bValue) return -1;
			if (aValue < bValue) return 1;
			return 0;
		});

		return sortedProjects;
	}

	isInvalidProjectId({ id }: { id: string }): boolean {
		return this.invalidProjectIds.has(id);
	}

	markProjectIdAsInvalid({ id }: { id: string }): void {
		this.invalidProjectIds.add(id);
		this.notify();
	}

	clearInvalidProjectIds(): void {
		this.invalidProjectIds.clear();
		this.notify();
	}

	getActive(): TProject {
		if (!this.active) {
			throw new Error("No active project");
		}
		return this.active;
	}

	/**
	 * for agents:
	 * in most cases, the project is guaranteed to be active, in which getActive() should be used instead.
	 * for very rare cases, this function may be used.
	 */
	getActiveOrNull(): TProject | null {
		return this.active;
	}

	getTimelineViewState(): TTimelineViewState {
		return this.active?.timelineViewState ?? DEFAULTS.timeline.viewState;
	}

	setTimelineViewState({ viewState }: { viewState: TTimelineViewState }): void {
		if (!this.active) return;
		this.active = {
			...this.active,
			timelineViewState: viewState ?? undefined,
		};
		this.editor.save.markDirty();
		this.notify();
	}

	getSavedProjects(): TProjectMetadata[] {
		return this.savedProjects;
	}

	getIsLoading(): boolean {
		return this.isLoading;
	}

	getLoadedProjectId(): string | null {
		return this.loadedProjectId;
	}

	/** Why the last load failed, and of which project: null while one loads,
	 * or once one has. */
	getLoadError(): { projectId: string; message: string } | null {
		return this.loadError;
	}

	getIsInitialized(): boolean {
		return this.isInitialized;
	}

	getMigrationState(): MigrationState {
		return this.migrationState;
	}

	setActiveProject({ project }: { project: TProject }): void {
		this.active = project;
		this.notify();
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private updateMetadata(project: TProject): void {
		const index = this.savedProjects.findIndex(
			(p) => p.id === project.metadata.id,
		);

		if (index !== -1) {
			this.savedProjects = this.savedProjects.with(index, project.metadata);
		} else {
			this.savedProjects = [project.metadata, ...this.savedProjects];
		}

		this.notify();
	}

	private notify(): void {
		this.listeners.forEach((fn) => {
			fn();
		});
	}
}
