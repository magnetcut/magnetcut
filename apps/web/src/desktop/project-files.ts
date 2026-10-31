import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { EditorCore } from "@/core";
import { openDiskFile } from "@/media/disk-file";
import { getEditorUrl } from "@/project/editor-url";
import { toProjectFile } from "@/project/file";
import { importProjectFile } from "@/project/open-file";

// File, Open Project… and Save Project As… (docs/AUTOMATION.md): a project as
// a .magnetcut file, its media by where they are, through the system's
// dialogs (apps/desktop/src/project_file.rs).

/** Asks for a project file and opens it as a project of its own. */
export async function openProjectFromDisk({
	navigate,
}: {
	navigate: (url: string) => void;
}): Promise<void> {
	try {
		const picked = await invoke<{ path: string; text: string } | null>(
			"pick_project_file",
		);
		if (!picked) return;
		const { id, missing } = await importProjectFile({
			text: picked.text,
			openMedium: async ({ path }) => {
				const file = await openDiskFile({ path });
				if (!file) throw new Error("it isn't there");
				return file;
			},
		});
		navigate(getEditorUrl({ projectId: id }));
		if (missing.length > 0) {
			toast.warning(
				`${missing.length} ${missing.length === 1 ? "file" : "files"} not found`,
				{ description: missing.join("\n") },
			);
		}
	} catch (error) {
		toast.error("Couldn't open the project", {
			description: error instanceof Error ? error.message : String(error),
		});
	}
}

/** Asks where, and saves the open project there as a file. */
export async function saveProjectToDisk(): Promise<void> {
	const editor = EditorCore.getInstance();
	const project = editor.project.getActiveOrNull();
	if (!project || location.pathname !== "/editor") {
		toast.error("Open a project to save it");
		return;
	}
	try {
		await editor.project.saveCurrentProject();
		const { text, leftOut } = toProjectFile({
			project,
			assets: editor.media.getAssets(),
		});
		const path = await invoke<string | null>("save_project_file", {
			name: project.metadata.name,
			text,
		});
		if (!path) return;
		toast.success(`Saved ${path.split(/[\\/]/).pop()}`, {
			description:
				leftOut.length > 0
					? `Not in it, as they aren't files on disk: ${leftOut.join(", ")}`
					: undefined,
		});
	} catch (error) {
		toast.error("Couldn't save the project", {
			description: error instanceof Error ? error.message : String(error),
		});
	}
}
