import { describe, expect, test } from "bun:test";
import { StorageService } from "../service";
import type { MediaAssetData, StorageAdapter } from "../types";

/** Storage in memory, for IndexedDB and OPFS alike. */
class MemoryAdapter<T> implements StorageAdapter<T> {
	readonly entries = new Map<string, T>();

	async get(key: string): Promise<T | null> {
		return this.entries.get(key) ?? null;
	}

	async set({ key, value }: { key: string; value: T }): Promise<void> {
		this.entries.set(key, value);
	}

	async remove(key: string): Promise<void> {
		this.entries.delete(key);
	}

	async list(): Promise<string[]> {
		return [...this.entries.keys()];
	}

	async clear(): Promise<void> {
		this.entries.clear();
	}
}

/** The storage service, each project's media kept in memory. */
function makeService() {
	const projects = new Map<
		string,
		{
			mediaMetadataAdapter: MemoryAdapter<MediaAssetData>;
			mediaAssetsAdapter: MemoryAdapter<File>;
		}
	>();
	const adapters = ({ projectId }: { projectId: string }) => {
		let project = projects.get(projectId);
		if (!project) {
			project = {
				mediaMetadataAdapter: new MemoryAdapter<MediaAssetData>(),
				mediaAssetsAdapter: new MemoryAdapter<File>(),
			};
			projects.set(projectId, project);
		}
		return project;
	};
	const service = new StorageService();
	// In place of its own, which open IndexedDB and OPFS.
	Object.assign(service, { getProjectMediaAdapters: adapters });
	return { service, adapters };
}

describe("a medium, stored and loaded again", () => {
	test("keeps its frame rate, and whether it has sound", async () => {
		const { service } = makeService();
		await service.saveMediaAsset({
			projectId: "p",
			mediaAsset: {
				id: "m1",
				name: "silent.mp4",
				type: "video",
				file: new File(["frames"], "silent.mp4"),
				duration: 3,
				fps: 25,
				hasAudio: false,
			},
		});

		const loaded = await service.loadMediaAsset({ projectId: "p", id: "m1" });

		expect(loaded?.fps).toBe(25);
		expect(loaded?.hasAudio).toBe(false);
	});
});

describe("copying a project's media, as a duplicate does", () => {
	test("keeps a file on disk that has gone, and copies the files in storage", async () => {
		const { service, adapters } = makeService();
		const source = adapters({ projectId: "p" });
		const gone: MediaAssetData = {
			id: "m1",
			name: "film.mp4",
			type: "video",
			size: 100,
			lastModified: 0,
			path: "/films/film.mp4",
			fps: 30,
			hasAudio: true,
		};
		const stored: MediaAssetData = {
			id: "m2",
			name: "pasted.png",
			type: "image",
			size: 5,
			lastModified: 0,
			proxy: { width: 640, height: 360 },
		};
		await source.mediaMetadataAdapter.set({ key: "m1", value: gone });
		await source.mediaMetadataAdapter.set({ key: "m2", value: stored });
		const file = new File(["image"], "pasted.png");
		const proxy = new File(["small"], "m2.proxy");
		await source.mediaAssetsAdapter.set({ key: "m2", value: file });
		await source.mediaAssetsAdapter.set({ key: "m2.proxy", value: proxy });

		await service.copyProjectMedia({ fromProjectId: "p", toProjectId: "q" });

		const copy = adapters({ projectId: "q" });
		expect(await copy.mediaMetadataAdapter.get("m1")).toEqual(gone);
		expect(await copy.mediaMetadataAdapter.get("m2")).toEqual(stored);
		expect(await copy.mediaAssetsAdapter.get("m2")).toBe(file);
		expect(await copy.mediaAssetsAdapter.get("m2.proxy")).toBe(proxy);
		expect(await copy.mediaAssetsAdapter.list()).toHaveLength(2);
	});
});
