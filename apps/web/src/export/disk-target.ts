import { invoke } from "@tauri-apps/api/core";
import type { StreamTargetChunk } from "mediabunny";
import { isAppleDevice, isLinux } from "@/utils/platform";
import { DiskFile, type DiskFileInfo } from "@/media/disk-file";

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
	/** Deletes what was written: the export was cancelled or failed. */
	discard: () => Promise<void>;
}

/** A file being written by the desktop app, by the id it gave. */
function toExportFile({ id }: { id: number }): ExportFile {
	// Kept once closed, but still discarded after that: mediabunny closes the
	// file when its output is cancelled, before the export discards it.
	let state: "open" | "kept" | "discarded" = "open";
	const close = async ({ keep }: { keep: boolean }) => {
		if (state === "discarded" || (keep && state === "kept")) return;
		state = keep ? "kept" : "discarded";
		await invoke("close_export_file", { id, keep });
	};
	return {
		writable: new WritableStream<StreamTargetChunk>({
			write: async (chunk) => {
				await invoke("write_export_file", chunk.data, {
					headers: {
						"export-id": String(id),
						position: String(chunk.position),
					},
				});
			},
			close: () => close({ keep: true }),
			abort: () => close({ keep: false }),
		}),
		discard: () => close({ keep: false }),
	};
}

/** Starts writing to a file picked in the save dialog. */
export async function openExportFile({
	path,
}: {
	path: string;
}): Promise<ExportFile> {
	const id = await invoke<number>("open_export_file", { path });
	return toExportFile({ id });
}

/** The folder of a file's path. */
export function getFolderOf({ path }: { path: string }): string {
	return path.replace(/[\\/][^\\/]*$/, "");
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
	return { file: toExportFile({ id }), path };
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
