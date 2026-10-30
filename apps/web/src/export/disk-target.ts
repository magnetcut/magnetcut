import { invoke } from "@tauri-apps/api/core";
import type { StreamTargetChunk } from "mediabunny";
import { isAppleDevice, isLinux } from "@/utils/platform";

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
	const directory = besidePath?.replace(/[\\/][^\\/]*$/, "") || null;
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

/** Starts writing to a file picked in the save dialog. */
export async function openExportFile({
	path,
}: {
	path: string;
}): Promise<ExportFile> {
	const id = await invoke<number>("open_export_file", { path });
	let isClosed = false;
	const close = async ({ keep }: { keep: boolean }) => {
		if (isClosed) return;
		isClosed = true;
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

/** Shows an export where it was saved. */
export function revealExportFile({ path }: { path: string }): Promise<void> {
	return invoke("reveal_export_file", { path });
}

/** What showing a file where it is is called on this system. */
export function getRevealLabel(): string {
	if (isAppleDevice()) return "Show in Finder";
	return isLinux() ? "Show in folder" : "Show in Explorer";
}
