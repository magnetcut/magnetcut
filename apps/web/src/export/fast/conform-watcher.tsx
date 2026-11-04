"use client";

import { useEffect } from "react";
import { useEditor } from "@/editor/use-editor";
import { useExportChoicesStore } from "@/export/choices-store";
import {
	chooseConformTarget,
	collectConformFiles,
	planConform,
} from "./conform";
import { useConformStore } from "./conform-store";

/**
 * Keeps the conform store's odd files up to date while Fast mode is the
 * Export mode chosen: the timeline marks their clips with a "!". With Fast
 * mode off, none: a normal export draws every frame, and they don't matter.
 */
export function ConformWatcher() {
	const fastMode = useExportChoicesStore((state) => state.choices.fastMode);
	const tracks = useEditor((editor) => editor.scenes.getActiveScene().tracks);
	const mediaAssets = useEditor((editor) => editor.media.getAssets());
	const setOdd = useConformStore((state) => state.setOdd);

	useEffect(() => {
		if (fastMode === "off") {
			setOdd(new Map());
			return;
		}
		let isCurrent = true;
		collectConformFiles({ tracks, mediaAssets })
			.then((files) => {
				if (!isCurrent) return;
				const target = chooseConformTarget({ files });
				const plan = target ? planConform({ files, target }) : null;
				setOdd(
					new Map(
						(plan?.files ?? []).map(({ file, difference }) => [
							file.asset.id,
							difference,
						]),
					),
				);
			})
			.catch((error: unknown) => {
				console.warn("Couldn't look at the main track's files:", error);
				if (isCurrent) setOdd(new Map());
			});
		return () => {
			isCurrent = false;
		};
	}, [fastMode, tracks, mediaAssets, setOdd]);

	return null;
}
