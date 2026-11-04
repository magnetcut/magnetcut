import type { TProject, TProjectMetadata } from "@/project/types";
import { getProjectDurationFromScenes } from "@/timeline/scenes";
import type { MediaAsset, MediaProxy } from "@/media/types";
import {
	createObjectUrl,
	DiskFile,
	type MediaFile,
	openDiskFile,
} from "@/media/disk-file";
import { IndexedDBAdapter } from "./indexeddb-adapter";
import { OPFSAdapter } from "./opfs-adapter";
import {
	type StorageCapacityCheckResult,
	StorageQuotaExceededError,
	evaluateStorageCapacity,
	isStorageQuotaExceededError,
	readStorageQuotaStatus,
} from "./quota";
import type {
	MediaAssetData,
	MediaProxyData,
	StorageConfig,
	SerializedProject,
	SerializedScene,
} from "./types";
import {
	migrations,
	runStorageMigrations,
} from "@/services/storage/migrations";
import type { Bookmark, SceneTracks, TScene } from "@/timeline";
import { roundMediaTime } from "@/wasm";

function normalizeBookmarks({ raw }: { raw: unknown }): Bookmark[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.map((item): Bookmark | null => {
			if (typeof item === "number") {
				return { time: roundMediaTime({ time: item }) };
			}
			const obj = item as Record<string, unknown>;
			if (
				typeof obj !== "object" ||
				obj === null ||
				typeof obj.time !== "number"
			) {
				return null;
			}
			return {
				time: roundMediaTime({ time: obj.time }),
				...(typeof obj.note === "string" && { note: obj.note }),
				...(typeof obj.color === "string" && { color: obj.color }),
				...(typeof obj.duration === "number" && {
					duration: roundMediaTime({ time: obj.duration }),
				}),
			};
		})
		.filter((b): b is Bookmark => b !== null);
}

/**
 * A media file kept where it is on disk, as it is now: images in memory, which
 * the editor draws from object URLs, the rest read by the piece. Null if it has
 * gone, or outside the desktop app.
 */
async function openMediaOnDisk({
	path,
	type,
}: {
	path: string;
	type: MediaAssetData["type"];
}): Promise<MediaFile | null> {
	try {
		const file = await openDiskFile({ path });
		if (!file) {
			console.warn(`Media file not found: ${path}`);
			return null;
		}
		return type === "image" ? await file.toFile() : file;
	} catch (error) {
		console.warn(`Couldn't open ${path}`, error);
		return null;
	}
}

/** Where a proxy kept in storage is, beside its asset's file. */
const proxyKey = ({ id }: { id: string }) => `${id}.proxy`;

function describeProxy({ proxy }: { proxy: MediaProxy }): MediaProxyData {
	return {
		width: proxy.width,
		height: proxy.height,
		path: proxy.file instanceof DiskFile ? proxy.file.path : undefined,
	};
}

function stripAudioBuffers({ tracks }: { tracks: SceneTracks }): SceneTracks {
	return {
		...tracks,
		audio: tracks.audio.map((track) => ({
			...track,
			elements: track.elements.map((element) => {
				const { buffer: _buffer, ...rest } = element;
				return rest;
			}),
		})),
	};
}

/** A project as it's stored, and as a project file holds it
 * (`@/project/file`). */
export function serializeProject({
	project,
}: {
	project: TProject;
}): SerializedProject {
	const duration =
		project.metadata.duration ??
		getProjectDurationFromScenes({ scenes: project.scenes });
	const serializedScenes: SerializedScene[] = project.scenes.map((scene) => ({
		id: scene.id,
		name: scene.name,
		isMain: scene.isMain,
		tracks: stripAudioBuffers({ tracks: scene.tracks }),
		bookmarks: scene.bookmarks,
		createdAt: scene.createdAt.toISOString(),
		updatedAt: scene.updatedAt.toISOString(),
	}));
	return {
		metadata: {
			id: project.metadata.id,
			name: project.metadata.name,
			thumbnail: project.metadata.thumbnail,
			duration,
			createdAt: project.metadata.createdAt.toISOString(),
			updatedAt: project.metadata.updatedAt.toISOString(),
		},
		scenes: serializedScenes,
		currentSceneId: project.currentSceneId,
		settings: project.settings,
		version: project.version,
		timelineViewState: project.timelineViewState,
	};
}

/** A stored project as the editor has it. */
export function deserializeProject({
	serialized,
}: {
	serialized: SerializedProject;
}): TProject {
	const scenes =
		serialized.scenes?.map((scene) => ({
			id: scene.id,
			name: scene.name,
			isMain: scene.isMain,
			tracks: scene.tracks,
			bookmarks: normalizeBookmarks({ raw: scene.bookmarks }),
			createdAt: new Date(scene.createdAt),
			updatedAt: new Date(scene.updatedAt),
		})) ?? [];
	return {
		metadata: {
			id: serialized.metadata.id,
			name: serialized.metadata.name,
			thumbnail: serialized.metadata.thumbnail,
			duration: roundMediaTime({
				time:
					serialized.metadata.duration ??
					getProjectDurationFromScenes({ scenes }),
			}),
			createdAt: new Date(serialized.metadata.createdAt),
			updatedAt: new Date(serialized.metadata.updatedAt),
		},
		scenes,
		currentSceneId: serialized.currentSceneId || "",
		settings: serialized.settings,
		version: serialized.version,
		timelineViewState: serialized.timelineViewState,
	};
}

class StorageService {
	private projectsAdapter: IndexedDBAdapter<SerializedProject>;
	private config: StorageConfig;
	private migrationsPromise: Promise<void> | null = null;

	constructor() {
		this.config = {
			projectsDb: "video-editor-projects",
			mediaDb: "video-editor-media",
			version: 1,
		};

		this.projectsAdapter = new IndexedDBAdapter<SerializedProject>({
			dbName: this.config.projectsDb,
			storeName: "projects",
			version: this.config.version,
		});
	}

	private async ensureMigrations(): Promise<void> {
		if (this.migrationsPromise) {
			await this.migrationsPromise;
			return;
		}

		this.migrationsPromise = runStorageMigrations({ migrations }).then(
			() => undefined,
		);
		await this.migrationsPromise;
	}

	private getProjectMediaAdapters({ projectId }: { projectId: string }) {
		const mediaMetadataAdapter = new IndexedDBAdapter<MediaAssetData>({
			dbName: `${this.config.mediaDb}-${projectId}`,
			storeName: "media-metadata",
			version: this.config.version,
		});

		const mediaAssetsAdapter = new OPFSAdapter(`media-files-${projectId}`);

		return { mediaMetadataAdapter, mediaAssetsAdapter };
	}

	async canStoreFile({
		size,
	}: {
		size: number;
	}): Promise<StorageCapacityCheckResult> {
		const quotaStatus = await readStorageQuotaStatus();
		return evaluateStorageCapacity({
			requiredBytes: size,
			quotaStatus,
		});
	}

	isQuotaExceededError({ error }: { error: unknown }): boolean {
		return isStorageQuotaExceededError({ error });
	}

	async saveProject({ project }: { project: TProject }): Promise<void> {
		await this.projectsAdapter.set({
			key: project.metadata.id,
			value: serializeProject({ project }),
		});
	}

	async loadProject({
		id,
	}: {
		id: string;
	}): Promise<{ project: TProject } | null> {
		await this.ensureMigrations();
		const serializedProject = await this.projectsAdapter.get(id);

		if (!serializedProject) return null;

		if (
			typeof serializedProject !== "object" ||
			serializedProject === null ||
			typeof serializedProject.metadata !== "object" ||
			serializedProject.metadata === null
		) {
			console.warn(
				"[storage] Skipping malformed project entry (missing metadata):",
				{ id, entry: serializedProject },
			);
			return null;
		}

		return { project: deserializeProject({ serialized: serializedProject }) };
	}

	async loadAllProjects(): Promise<TProject[]> {
		const projectIds = await this.projectsAdapter.list();
		const projects: TProject[] = [];

		for (const id of projectIds) {
			const result = await this.loadProject({ id });
			if (result?.project) {
				projects.push(result.project);
			}
		}

		return projects.sort(
			(a, b) => b.metadata.updatedAt.getTime() - a.metadata.updatedAt.getTime(),
		);
	}

	async loadAllProjectsMetadata(): Promise<TProjectMetadata[]> {
		await this.ensureMigrations();
		const serializedProjects = await this.projectsAdapter.getAll();

		const metadata: TProjectMetadata[] = [];
		for (const serializedProject of serializedProjects) {
			if (
				typeof serializedProject !== "object" ||
				serializedProject === null ||
				typeof serializedProject.metadata !== "object" ||
				serializedProject.metadata === null
			) {
				console.warn(
					"[storage] Skipping malformed project entry (missing metadata):",
					serializedProject,
				);
				continue;
			}

			metadata.push({
				id: serializedProject.metadata.id,
				name: serializedProject.metadata.name,
				thumbnail: serializedProject.metadata.thumbnail,
				duration: roundMediaTime({
					time:
						serializedProject.metadata.duration ??
						getProjectDurationFromScenes({
							scenes: (serializedProject.scenes ?? []) as unknown as TScene[],
						}),
				}),
				createdAt: new Date(serializedProject.metadata.createdAt),
				updatedAt: new Date(serializedProject.metadata.updatedAt),
			});
		}

		return metadata.sort(
			(a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
		);
	}

	async deleteProject({ id }: { id: string }): Promise<void> {
		await this.projectsAdapter.remove(id);
	}

	async saveMediaAsset({
		projectId,
		mediaAsset,
	}: {
		projectId: string;
		mediaAsset: MediaAsset;
	}): Promise<void> {
		const { mediaMetadataAdapter, mediaAssetsAdapter } =
			this.getProjectMediaAdapters({ projectId });

		const metadata: MediaAssetData = {
			id: mediaAsset.id,
			name: mediaAsset.name,
			type: mediaAsset.type,
			size: mediaAsset.file.size,
			lastModified: mediaAsset.file.lastModified,
			path: mediaAsset.path,
			width: mediaAsset.width,
			height: mediaAsset.height,
			duration: mediaAsset.duration,
			thumbnailUrl: mediaAsset.thumbnailUrl,
			ephemeral: mediaAsset.ephemeral,
			proxy: mediaAsset.proxy
				? describeProxy({ proxy: mediaAsset.proxy })
				: undefined,
		};

		try {
			// A file on disk stays there: only what describes it is kept.
			if (!mediaAsset.path) {
				if (mediaAsset.file instanceof DiskFile) {
					throw new Error(`${mediaAsset.name} is on disk but has no path`);
				}
				await mediaAssetsAdapter.set({
					key: mediaAsset.id,
					value: mediaAsset.file,
				});
			}
			const proxyFile = mediaAsset.proxy?.file;
			if (proxyFile && !(proxyFile instanceof DiskFile)) {
				await mediaAssetsAdapter.set({
					key: proxyKey({ id: mediaAsset.id }),
					value: proxyFile,
				});
			}
			await mediaMetadataAdapter.set({
				key: mediaAsset.id,
				value: metadata,
			});
		} catch (error) {
			try {
				await mediaAssetsAdapter.remove(mediaAsset.id);
			} catch {
				// Ignore cleanup failures so the original storage error is preserved.
			}

			if (this.isQuotaExceededError({ error })) {
				throw new StorageQuotaExceededError({
					requiredBytes: mediaAsset.file.size,
				});
			}

			throw error;
		}
	}

	/**
	 * Gives an asset its proxy, or takes it away (null): what describes it, and
	 * in a browser the file, kept beside the asset's.
	 */
	async saveMediaProxy({
		projectId,
		id,
		proxy,
	}: {
		projectId: string;
		id: string;
		proxy: MediaProxy | null;
	}): Promise<void> {
		const { mediaMetadataAdapter, mediaAssetsAdapter } =
			this.getProjectMediaAdapters({ projectId });
		const metadata = await mediaMetadataAdapter.get(id);
		if (!metadata) return;
		const key = proxyKey({ id });
		if (proxy && !(proxy.file instanceof DiskFile)) {
			await mediaAssetsAdapter.set({ key, value: proxy.file });
		} else {
			await mediaAssetsAdapter.remove(key);
		}
		await mediaMetadataAdapter.set({
			key: id,
			value: {
				...metadata,
				proxy: proxy ? describeProxy({ proxy }) : undefined,
			},
		});
	}

	/** An asset's proxy, if it has one that's still there. */
	private async loadMediaProxy({
		metadata,
		mediaAssetsAdapter,
	}: {
		metadata: MediaAssetData;
		mediaAssetsAdapter: OPFSAdapter;
	}): Promise<MediaProxy | undefined> {
		const data = metadata.proxy;
		if (!data) return undefined;
		// A proxy that's gone isn't missing media: the original plays instead.
		const file = data.path
			? await openMediaOnDisk({ path: data.path, type: "video" })
			: await mediaAssetsAdapter
					.get(proxyKey({ id: metadata.id }))
					.catch(() => null);
		return file ? { file, width: data.width, height: data.height } : undefined;
	}

	async loadMediaAsset({
		projectId,
		id,
	}: {
		projectId: string;
		id: string;
	}): Promise<MediaAsset | null> {
		const { mediaMetadataAdapter, mediaAssetsAdapter } =
			this.getProjectMediaAdapters({ projectId });

		const metadata = await mediaMetadataAdapter.get(id);
		if (!metadata) return null;
		const file = metadata.path
			? await openMediaOnDisk({ path: metadata.path, type: metadata.type })
			: await mediaAssetsAdapter.get(id);
		if (!file) return null;

		let url: string | undefined;
		if (
			file instanceof File &&
			metadata.type === "image" &&
			(!file.type || file.type === "")
		) {
			try {
				const text = await file.text();
				if (text.trim().startsWith("<svg")) {
					const svgBlob = new Blob([text], { type: "image/svg+xml" });
					url = URL.createObjectURL(svgBlob);
				} else {
					url = URL.createObjectURL(file);
				}
			} catch {
				url = URL.createObjectURL(file);
			}
		} else {
			url = createObjectUrl({ file });
		}

		return {
			id: metadata.id,
			name: metadata.name,
			type: metadata.type,
			file,
			url,
			path: metadata.path,
			width: metadata.width,
			height: metadata.height,
			duration: metadata.duration,
			thumbnailUrl: metadata.thumbnailUrl,
			ephemeral: metadata.ephemeral,
			proxy: await this.loadMediaProxy({ metadata, mediaAssetsAdapter }),
		};
	}

	async loadAllMediaAssets({
		projectId,
		onMissing,
	}: {
		projectId: string;
		/** The files on disk that have gone, by name. */
		onMissing?: ({ names }: { names: string[] }) => void;
	}): Promise<MediaAsset[]> {
		const { mediaMetadataAdapter } = this.getProjectMediaAdapters({
			projectId,
		});

		const mediaIds = await mediaMetadataAdapter.list();
		const mediaItems: MediaAsset[] = [];
		const missing: string[] = [];

		for (const id of mediaIds) {
			const item = await this.loadMediaAsset({ projectId, id });
			if (item) {
				mediaItems.push(item);
				continue;
			}
			const metadata = await mediaMetadataAdapter.get(id);
			if (metadata?.path) missing.push(metadata.name);
		}

		if (missing.length > 0) onMissing?.({ names: missing });
		return mediaItems;
	}

	async deleteMediaAsset({
		projectId,
		id,
	}: {
		projectId: string;
		id: string;
	}): Promise<void> {
		const { mediaMetadataAdapter, mediaAssetsAdapter } =
			this.getProjectMediaAdapters({ projectId });

		await Promise.all([
			mediaAssetsAdapter.remove(id),
			mediaAssetsAdapter.remove(proxyKey({ id })),
			mediaMetadataAdapter.remove(id),
		]);
	}

	async deleteProjectMedia({
		projectId,
	}: {
		projectId: string;
	}): Promise<void> {
		const { mediaMetadataAdapter, mediaAssetsAdapter } =
			this.getProjectMediaAdapters({ projectId });

		await Promise.all([
			mediaMetadataAdapter.clear(),
			mediaAssetsAdapter.clear(),
		]);
	}

	async clearAllData(): Promise<void> {
		await this.projectsAdapter.clear();
		// project-specific media and timelines cleaned up when projects are deleted
	}

	async getStorageInfo(): Promise<{
		projects: number;
		isOPFSSupported: boolean;
		isIndexedDBSupported: boolean;
	}> {
		const projectIds = await this.projectsAdapter.list();

		return {
			projects: projectIds.length,
			isOPFSSupported: this.isOPFSSupported(),
			isIndexedDBSupported: this.isIndexedDBSupported(),
		};
	}

	async getProjectStorageInfo({ projectId }: { projectId: string }): Promise<{
		mediaItems: number;
	}> {
		const { mediaMetadataAdapter } = this.getProjectMediaAdapters({
			projectId,
		});

		const mediaIds = await mediaMetadataAdapter.list();

		return {
			mediaItems: mediaIds.length,
		};
	}

	isOPFSSupported(): boolean {
		return OPFSAdapter.isSupported();
	}

	isIndexedDBSupported(): boolean {
		return "indexedDB" in window;
	}

	isFullySupported(): boolean {
		return this.isIndexedDBSupported() && this.isOPFSSupported();
	}
}

export const storageService = new StorageService();
export { StorageService };
