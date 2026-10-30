import type { StorageAdapter } from "./types";
import type { OpfsWriteRequest, OpfsWriteResponse } from "./opfs-write-worker";

/** Writes through a sync access handle, in a worker of its own. */
function writeInWorker({
	directoryName,
	key,
	file,
}: OpfsWriteRequest): Promise<void> {
	const worker = new Worker(new URL("./opfs-write-worker.ts", import.meta.url), {
		type: "module",
	});
	return new Promise<void>((resolve, reject) => {
		worker.onmessage = (event: MessageEvent<OpfsWriteResponse>) => {
			worker.terminate();
			if (event.data.ok) {
				resolve();
			} else {
				reject(new Error(event.data.error));
			}
		};
		worker.onerror = (event) => {
			worker.terminate();
			reject(new Error(event.message || "Couldn't write the file"));
		};
		const request: OpfsWriteRequest = { directoryName, key, file };
		worker.postMessage(request);
	});
}

export class OPFSAdapter implements StorageAdapter<File> {
	private directoryName: string;

	constructor(directoryName = "media") {
		this.directoryName = directoryName;
	}

	private async getDirectory(): Promise<FileSystemDirectoryHandle> {
		const opfsRoot = await navigator.storage.getDirectory();
		return await opfsRoot.getDirectoryHandle(this.directoryName, {
			create: true,
		});
	}

	async get(key: string): Promise<File | null> {
		try {
			const directory = await this.getDirectory();
			const fileHandle = await directory.getFileHandle(key);
			return await fileHandle.getFile();
		} catch (error) {
			if ((error as Error).name === "NotFoundError") {
				return null;
			}
			throw error;
		}
	}

	async set({
		key,
		value: file,
	}: {
		key: string;
		value: File;
	}): Promise<void> {
		if (!("createWritable" in FileSystemFileHandle.prototype)) {
			await writeInWorker({ directoryName: this.directoryName, key, file });
			return;
		}

		const directory = await this.getDirectory();
		const fileHandle = await directory.getFileHandle(key, { create: true });
		const writable = await fileHandle.createWritable();

		await writable.write(file);
		await writable.close();
	}

	async remove(key: string): Promise<void> {
		try {
			const directory = await this.getDirectory();
			await directory.removeEntry(key);
		} catch (error) {
			if ((error as Error).name !== "NotFoundError") {
				throw error;
			}
		}
	}

	async list(): Promise<string[]> {
		const directory = await this.getDirectory();
		const keys: string[] = [];

		for await (const name of directory.keys()) {
			keys.push(name);
		}

		return keys;
	}

	async clear(): Promise<void> {
		const directory = await this.getDirectory();

		for await (const name of directory.keys()) {
			await directory.removeEntry(name);
		}
	}

	// Helper method to check OPFS support
	static isSupported(): boolean {
		return "storage" in navigator && "getDirectory" in navigator.storage;
	}
}
