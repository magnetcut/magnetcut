import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { EditorCore } from "@/core";
import { DiskFile, type DiskFileInfo } from "@/media/disk-file";
import { importMediaFiles } from "@/media/import";
import { getEditorUrl } from "@/project/editor-url";
import { openProjectText } from "./project-files";

// Videos and projects opened with MagnetCut from the Finder, a file manager,
// Explorer or the command line (apps/desktop/src/opened.rs). A video goes into
// the open project's media; with none open, as when MagnetCut starts with it,
// into a new project of its own, named after the first. A .magnetcut opens as
// File, Open Project… opens it: a project of its own.

/** What the desktop app has had opened with it since the page last asked. */
interface Opened {
	media: DiskFileInfo[];
	projects: Array<{ path: string; text: string }>;
	unreadable: string[];
}

/** A new project's name: its first file's, without the extension. */
export function projectNameFor({
	files,
}: {
	files: Array<{ name: string }>;
}): string {
	const name = (files[0]?.name ?? "").replace(/\.[^.]*$/, "").trim();
	return name || "New project";
}

/** Takes what was opened with MagnetCut since the page last asked, and opens
 * it: the media first, then each project file. */
export async function openOpenedFiles({
	navigate,
	editor = EditorCore.getInstance(),
	importFiles = importMediaFiles,
	openProject = openProjectText,
}: {
	navigate: (url: string) => void;
	editor?: EditorCore;
	importFiles?: typeof importMediaFiles;
	openProject?: typeof openProjectText;
}): Promise<void> {
	const opened = await invoke<Opened>("take_opened_files");
	for (const line of opened.unreadable) {
		toast.error("Couldn't open the project", { description: line });
	}
	if (opened.media.length > 0) {
		await openMedia({
			files: opened.media.map((info) => new DiskFile(info)),
			navigate,
			editor,
			importFiles,
		});
	}
	for (const project of opened.projects) {
		await openProject({ text: project.text, navigate });
	}
}

/** Media into the project open in the editor, or a new one of their own. */
async function openMedia({
	files,
	navigate,
	editor,
	importFiles,
}: {
	files: DiskFile[];
	navigate: (url: string) => void;
	editor: EditorCore;
	importFiles: typeof importMediaFiles;
}): Promise<void> {
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
