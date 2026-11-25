import { invoke } from "@tauri-apps/api/core";
import type { StreamTargetChunk } from "mediabunny";
import { isAppleDevice, isLinux } from "@/utils/platform";
import { DiskFile, type DiskFileInfo } from "@/media/disk-file";
import type { FileTags } from "@/project/file-tags";

/**
 * The desktop app's save dialog for an export (apps/desktop/src/export.rs),
 * opening beside `besidePath` if given: where it goes, or null if cancelled.
 */
export function pickExportFile({
	name,
	extension,
	besidePath,
}: {
	name: string;
	extension: string;
	besidePath?: string;
}): Promise<string | null> {
	const directory = besidePath ? getFolderOf({ path: besidePath }) : null;
	return invoke<string | null>("pick_export_file", {
		name,
		extension,
		directory,
	});
}

/** An export's file on disk, written as mediabunny makes it. */
export interface ExportFile {
	writable: WritableStream<StreamTargetChunk>;
	/**
	 * Writes bytes at a position, for a file written by hand rather than
	 * through `writable`, which a failed write closes for good: after one of
	 * these fails, the file is still open, as it was.
	 */
	write: ({
		data,
		position,
	}: {
		data: Uint8Array<ArrayBuffer>;
		position: number;
	}) => Promise<void>;
	/** Closes the file, keeping it, for a file written by hand. */
	keep: () => Promise<void>;
	/** Deletes what was written: the export was cancelled or failed. */
	discard: () => Promise<void>;
	/**
	 * The export finished: it takes the place of the file picked, which until
	 * now was left as it was. A file in a folder is in its place once closed.
	 * An MP4's details, `tags`, are written into it first, by the desktop
	 * app, as it writes its own exports' (apps/desktop/src/render/
	 * mp4_index.rs): it fails if they can't be, and the file goes.
	 */
	commit: ({ tags }?: { tags?: FileTags }) => Promise<void>;
}

/**
 * A file being written by the desktop app, by the id it gave; for an export,
 * beside the file picked until it's committed.
 */
function toExportFile({
	id,
	isExport,
}: {
	id: number;
	isExport: boolean;
}): ExportFile {
	// Kept once closed, but still discarded after that: mediabunny closes the
	// file when its output is cancelled, before the export discards it. Only
	// a commit says it finished.
	let state: "open" | "kept" | "committed" | "discarded" = "open";
	const close = async ({ keep }: { keep: boolean }) => {
		if (state === "discarded" || state === "committed") return;
		if (keep && state === "kept") return;
		state = keep ? "kept" : "discarded";
		await invoke("close_export_file", { id, keep });
	};
	const commit = async ({ tags }: { tags?: FileTags } = {}) => {
		if (state === "committed") return;
		if (state !== "kept") throw new Error("The export isn't finished");
		if (isExport) await invoke("commit_export_file", { id, tags });
		state = "committed";
	};
	const write = async ({
		data,
		position,
	}: {
		data: Uint8Array<ArrayBuffer>;
		position: number;
	}) => {
		await invoke("write_export_file", data, {
			headers: { "export-id": String(id), position: String(position) },
		});
	};
	return {
		writable: new WritableStream<StreamTargetChunk>({
			write: (chunk) => write(chunk),
			close: () => close({ keep: true }),
			abort: () => close({ keep: false }),
		}),
		write,
		keep: () => close({ keep: true }),
		discard: () => close({ keep: false }),
		commit,
	};
}

/**
 * Starts writing to a file picked in the save dialog: beside it, until
 * `commit` puts it there, so a cancelled or failed export leaves it as it was.
 */
export async function openExportFile({
	path,
}: {
	path: string;
}): Promise<ExportFile> {
	const id = await invoke<number>("open_export_file", { path });
	return toExportFile({ id, isExport: true });
}

/** The folder of a file's path. */
export function getFolderOf({ path }: { path: string }): string {
	return path.replace(/[\\/][^\\/]*$/, "");
}

/**
 * Whether two paths the app gave name the same file, as the system compares
 * names: regardless of case on a Mac and on Windows, and of how an accent is
 * written on a Mac.
 */
export function isSamePath({ a, b }: { a: string; b: string }): boolean {
	const normalize = (path: string) => {
		if (isLinux()) return path;
		const unified = isAppleDevice() ? path : path.replace(/\\/g, "/");
		return unified.normalize("NFC").toLowerCase();
	};
	return normalize(a) === normalize(b);
}

/**
 * The desktop app's folder dialog, opening beside `besidePath` if given: a
 * folder the editor may write its own files into (clips converted,
 * recordings), or null if cancelled.
 */
export function pickFolder({
	title,
	besidePath,
}: {
	title: string;
	besidePath?: string;
}): Promise<string | null> {
	const directory = besidePath ? getFolderOf({ path: besidePath }) : null;
	return invoke<string | null>("pick_folder", { title, directory });
}

/**
 * A new file in a folder from `pickFolder`, written as an export is; named
 * `name`, or with a number added if that's taken, so nothing is replaced.
 */
export async function openFolderFile({
	folder,
	name,
}: {
	folder: string;
	name: string;
}): Promise<{ file: ExportFile; path: string }> {
	const { id, path } = await invoke<{ id: number; path: string }>(
		"open_folder_file",
		{ folder, name },
	);
	return { file: toExportFile({ id, isExport: false }), path };
}

/** A file written here and closed, given to the editor as a picked one is. */
export async function adoptSavedFile({
	path,
}: {
	path: string;
}): Promise<DiskFile> {
	return new DiskFile(await invoke<DiskFileInfo>("adopt_saved_file", { path }));
}

/** Shows an export where it was saved. */
export function revealExportFile({ path }: { path: string }): Promise<void> {
	return invoke("reveal_export_file", { path });
}

/** What showing a file where it is is called on this system. */
export function getRevealLabel(): string {
	if (isAppleDevice()) return "Show in Finder";
	return isLinux() ? "Show in folder" : "Show in Explorer";
}
