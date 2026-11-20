import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { EditorCore } from "@/core";
import { DiskFile, type DiskFileInfo } from "@/media/disk-file";
import { importMediaFiles } from "@/media/import";
import { getEditorUrl } from "@/project/editor-url";

// Videos opened with MagnetCut from the Finder's Open With, a file manager or
// the command line (apps/desktop/src/opened.rs): into the open project's
// media; with none open, as when MagnetCut starts with them, a new project of
// their own, named after the first.

/** A new project's name: its first file's, without the extension. */
export function projectNameFor({
	files,
}: {
	files: Array<{ name: string }>;
}): string {
	const name = (files[0]?.name ?? "").replace(/\.[^.]*$/, "").trim();
	return name || "New project";
}

/** Takes the files opened with MagnetCut since the page last asked, and
 * opens them. */
export async function openOpenedFiles({
	navigate,
	editor = EditorCore.getInstance(),
	importFiles = importMediaFiles,
}: {
	navigate: (url: string) => void;
	editor?: EditorCore;
	importFiles?: typeof importMediaFiles;
}): Promise<void> {
	const infos = await invoke<DiskFileInfo[]>("take_opened_files");
	if (infos.length === 0) return;
	const files = infos.map((info) => new DiskFile(info));
	try {
		const inEditor = globalThis.location?.pathname === "/editor";
		if (inEditor && editor.project.getActiveOrNull()) {
			await importFiles({ editor, files });
			return;
		}
		// Made the open project, which the media go into before the editor
		// shows it.
		const id = await editor.project.createNewProject({
			name: projectNameFor({ files }),
		});
		await importFiles({ editor, files });
		navigate(getEditorUrl({ projectId: id }));
	} catch (error) {
		toast.error("Couldn't open the files", {
			description: error instanceof Error ? error.message : String(error),
		});
	}
}
