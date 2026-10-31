import type { DiskFile } from "@/media/disk-file";
import { processMediaAssets } from "@/media/processing";
import { storageService } from "@/services/storage/service";
import { generateUUID } from "@/utils/id";
import { parseProjectFile } from "./file";

// A .magnetcut file made a project of its own (docs/AUTOMATION.md): a new one,
// whatever id it had, so that it never writes over one there already; its
// media opened from where they are and kept under their ids in the file, which
// the clips name. For the user's Open Project… and for agents alike.

/** Stores the project in `text`, `openMedium` opening each medium by its path:
 * the new project's id, and the media that couldn't be opened. */
export async function importProjectFile({
	text,
	openMedium,
}: {
	text: string;
	openMedium: (medium: { path: string }) => Promise<DiskFile>;
}): Promise<{ id: string; missing: string[] }> {
	const opened = parseProjectFile({ text });
	const id = generateUUID();
	const now = new Date();
	const project = {
		...opened.project,
		metadata: {
			...opened.project.metadata,
			id,
			thumbnail: undefined,
			createdAt: now,
			updatedAt: now,
		},
	};
	const missing: string[] = [];
	for (const medium of opened.media) {
		try {
			const file = await openMedium({ path: medium.path });
			const [asset] = await processMediaAssets({ files: [file] });
			if (!asset) throw new Error("it couldn't be read");
			await storageService.saveMediaAsset({
				projectId: id,
				mediaAsset: { ...asset, id: medium.id },
			});
		} catch (error) {
			missing.push(
				`${medium.name} (${medium.path}): ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	await storageService.saveProject({ project });
	return { id, missing };
}
