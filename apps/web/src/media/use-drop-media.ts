import { useEffect } from "react";
import { useEditor } from "@/editor/use-editor";
import { useAssetsPanelStore } from "@/components/editor/panels/assets/assets-panel-store";
import { findDroppedDiskFiles } from "./disk-file";
import { importMediaFiles } from "./import";

/**
 * Files dropped anywhere in the editor are imported. The assets panel and the
 * timeline take drops themselves; elsewhere the web view would otherwise open
 * the file in the editor's place, as a browser does.
 */
export function useDropMedia() {
	const editor = useEditor();

	useEffect(() => {
		const carriesFiles = (event: DragEvent) =>
			!event.defaultPrevented &&
			!editor.timeline.dragSource.isActive() &&
			(event.dataTransfer?.types.includes("Files") ?? false);

		const handleDragOver = (event: DragEvent) => {
			if (!carriesFiles(event)) return;
			event.preventDefault();
			if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
		};

		const handleDrop = (event: DragEvent) => {
			if (!carriesFiles(event)) return;
			event.preventDefault();
			const files = Array.from(event.dataTransfer?.files ?? []);
			if (files.length === 0) return;
			useAssetsPanelStore.getState().setActiveTab("media");
			findDroppedDiskFiles({ files })
				.then((found) => importMediaFiles({ editor, files: found }))
				.catch((error: unknown) => {
					console.error("Failed to import dropped files:", error);
				});
		};

		window.addEventListener("dragover", handleDragOver);
		window.addEventListener("drop", handleDrop);
		return () => {
			window.removeEventListener("dragover", handleDragOver);
			window.removeEventListener("drop", handleDrop);
		};
	}, [editor]);
}
