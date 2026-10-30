import { toast } from "sonner";
import type { EditorCore } from "@/core";
import type { MediaFile } from "./disk-file";
import { processMediaAssets } from "./processing";
import { showMediaUploadToast } from "./upload-toast";

/** Adds files to the open project's assets, as Import does. */
export async function importMediaFiles({
	editor,
	files,
	onProgress,
}: {
	editor: EditorCore;
	files: MediaFile[];
	onProgress?: (progress: number) => void;
}): Promise<void> {
	if (files.length === 0) return;
	const activeProject = editor.project.getActive();
	if (!activeProject) {
		toast.error("No active project");
		return;
	}

	await showMediaUploadToast({
		filesCount: files.length,
		promise: async () => {
			const processedAssets = await processMediaAssets({
				files,
				onProgress: ({ progress }: { progress: number }) =>
					onProgress?.(progress),
			});
			for (const asset of processedAssets) {
				await editor.media.addMediaAsset({
					projectId: activeProject.metadata.id,
					asset,
				});
			}
			return {
				uploadedCount: processedAssets.length,
				assetNames: processedAssets.map((asset) => asset.name),
			};
		},
	});
}
