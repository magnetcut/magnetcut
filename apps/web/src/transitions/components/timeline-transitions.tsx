"use client";

import { useMemo } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowRightDoubleIcon } from "@hugeicons/core-free-icons";
import { useEditor } from "@/editor/use-editor";
import type { VideoTrack } from "@/timeline";
import { timelineTimeToSnappedPixels } from "@/timeline/pixel-utils";
import {
	getTransitionDefinition,
	resolveTrackTransitions,
} from "@/transitions";
import { cn } from "@/utils/ui";
import type { MediaTime } from "@/wasm";

// Narrower than this, a bar would be hard to hit.
const MIN_BAR_WIDTH_PX = 8;
const ICON_MIN_WIDTH_PX = 24;

/**
 * A bar over each transition's window on a video track, which a click
 * selects; and a mark on the cut a dragged transition would go on.
 */
export function TimelineTransitions({
	track,
	zoomLevel,
	targetCutTime,
}: {
	track: VideoTrack;
	zoomLevel: number;
	targetCutTime: MediaTime | null;
}) {
	const editor = useEditor();
	const selected = useEditor((e) => e.selection.getSelectedTransition());
	const resolved = useMemo(() => resolveTrackTransitions({ track }), [track]);

	const bars = resolved.map(({ transition, window }) => {
		const left = timelineTimeToSnappedPixels({ time: window.start, zoomLevel });
		const right = timelineTimeToSnappedPixels({ time: window.end, zoomLevel });
		const width = Math.max(MIN_BAR_WIDTH_PX, right - left);
		const isSelected =
			selected?.trackId === track.id && selected.transitionId === transition.id;
		const { name } = getTransitionDefinition({ type: transition.type });

		return (
			<button
				key={transition.id}
				type="button"
				aria-label={`${name} transition`}
				title={name}
				className={cn(
					"absolute top-1/2 flex h-1/2 -translate-y-1/2 items-center justify-center rounded-sm border",
					"border-white/60 bg-black/45 text-white shadow-sm backdrop-blur-[1px] hover:bg-black/60",
					isSelected && "ring-primary bg-black/65 ring-2",
				)}
				style={{ left: left - (width - (right - left)) / 2, width }}
				// The track would start a box selection or deselect.
				onMouseDown={(event) => event.stopPropagation()}
				onMouseUp={(event) => event.stopPropagation()}
				onClick={(event) => {
					event.stopPropagation();
					editor.selection.setSelectedTransition({
						transition: { trackId: track.id, transitionId: transition.id },
					});
				}}
			>
				{width >= ICON_MIN_WIDTH_PX && (
					<HugeiconsIcon icon={ArrowRightDoubleIcon} className="size-3.5" />
				)}
			</button>
		);
	});

	return (
		<>
			{bars}
			{targetCutTime !== null && (
				<div
					aria-hidden="true"
					className="bg-primary ring-primary/40 pointer-events-none absolute inset-y-0 w-1 -translate-x-1/2 rounded-full ring-4"
					style={{
						left: timelineTimeToSnappedPixels({
							time: targetCutTime,
							zoomLevel,
						}),
					}}
				/>
			)}
		</>
	);
}
