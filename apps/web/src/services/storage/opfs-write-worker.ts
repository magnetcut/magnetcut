// Writes a file into the origin private file system through a sync access
// handle, which only a worker can open: the way for web views without
// createWritable (WebKitGTK).

export interface OpfsWriteRequest {
	directoryName: string;
	key: string;
	file: File;
}

export type OpfsWriteResponse = { ok: true } | { ok: false; error: string };

// Not in TypeScript's DOM library. Older WebKit returns promises.
interface SyncAccessHandle {
	truncate(size: number): void | Promise<void>;
	write(buffer: Uint8Array, options: { at: number }): number | Promise<number>;
	flush(): void | Promise<void>;
	close(): void | Promise<void>;
}

interface SyncAccessFileHandle extends FileSystemFileHandle {
	createSyncAccessHandle(): Promise<SyncAccessHandle>;
}

function canSyncAccess(
	handle: FileSystemFileHandle,
): handle is SyncAccessFileHandle {
	return "createSyncAccessHandle" in handle;
}

// Read and written a slice at a time, not the whole file in memory.
const SLICE_BYTES = 8 * 1024 * 1024;

async function write({ directoryName, key, file }: OpfsWriteRequest) {
	const root = await navigator.storage.getDirectory();
	const directory = await root.getDirectoryHandle(directoryName, {
		create: true,
	});
	const handle = await directory.getFileHandle(key, { create: true });
	if (!canSyncAccess(handle)) {
		throw new Error("This web view can't write files to its storage");
	}
	const access = await handle.createSyncAccessHandle();
	try {
		await access.truncate(0);
		for (let at = 0; at < file.size; at += SLICE_BYTES) {
			const bytes = new Uint8Array(
				await file.slice(at, at + SLICE_BYTES).arrayBuffer(),
			);
			let written = 0;
			while (written < bytes.length) {
				const count = await access.write(bytes.subarray(written), {
					at: at + written,
				});
				if (count <= 0) throw new Error("Storage is full");
				written += count;
			}
		}
		await access.flush();
	} finally {
		await access.close();
	}
}

self.onmessage = async (event: MessageEvent<OpfsWriteRequest>) => {
	let response: OpfsWriteResponse;
	try {
		await write(event.data);
		response = { ok: true };
	} catch (error) {
		response = {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
	self.postMessage(response);
};
