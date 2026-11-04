import { useEffect, useReducer, useState, type RefObject } from "react";
import { useEditor } from "@/editor/use-editor";
import { useCommittedRef } from "@/hooks/use-committed-ref";
import { addTransitionAtCut } from "@/transitions/add-at-cut";
import { replaceWithAsset } from "@/media/replace-actions";
import { findTrackInSceneTracks } from "@/timeline/track-element-update";
import {
	DragDropController,
	type DragDropConfig,
} from "@/timeline/controllers/drag-drop-controller";

interface UseTimelineDragDropProps {
	containerRef: RefObject<HTMLDivElement | null>;
	headerRef?: RefObject<HTMLElement | null>;
	tracksScrollRef?: RefObject<HTMLDivElement | null>;
	zoomLevel: number;
}

export function useTimelineDragDrop({
	containerRef,
	headerRef,
	tracksScrollRef,
	zoomLevel,
}: UseTimelineDragDropProps) {
	const editor = useEditor();

	const config: DragDropConfig = {
		zoomLevel,
		getContainerEl: () => containerRef.current,
		getHeaderEl: () => headerRef?.current ?? null,
		getTracksScrollEl: () => tracksScrollRef?.current ?? null,
		getActiveProjectFps: () => editor.project.getActive()?.settings.fps ?? null,
		getActiveProjectId: () =>
			editor.project.getActiveOrNull()?.metadata.id ?? null,
		getSceneTracks: () => editor.scenes.getActiveScene().tracks,
		getCurrentPlayheadTime: () => editor.playback.getCurrentTime(),
		getMediaAssets: () => editor.media.getAssets(),
		dragSource: editor.timeline.dragSource,
		addMediaAsset: (args) => editor.media.addMediaAsset(args),
		executeCommand: (command) => editor.command.execute({ command }),
		insertElement: (args) => editor.timeline.insertElement(args),
		addClipEffect: (args) => editor.timeline.addClipEffect(args),
		addTransitionAtCut: ({ cut, type }) =>
			addTransitionAtCut({ editor, cut, type }),
		replaceMedia: ({ trackId, elementId, asset }) => {
			const track = findTrackInSceneTracks({
				tracks: editor.scenes.getActiveScene().tracks,
				trackId,
			});
			const element = track?.elements.find(({ id }) => id === elementId);
			if (element) replaceWithAsset({ editor, trackId, element, asset });
		},
	};
	const configRef = useCommittedRef(config);
	const [controller] = useState(() => new DragDropController({ configRef }));

	const [, rerender] = useReducer((n: number) => n + 1, 0);
	useEffect(() => controller.subscribe(rerender), [controller]);
	useEffect(() => () => controller.destroy(), [controller]);

	return {
		isDragOver: controller.isDragOver,
		dropTarget: controller.dropTarget,
		dragElementType: controller.dragElementType,
		dropCut: controller.dropCut,
		dragProps: {
			onDragEnter: controller.onDragEnter,
			onDragOver: controller.onDragOver,
			onDragLeave: controller.onDragLeave,
			onDrop: controller.onDrop,
		},
	};
}
