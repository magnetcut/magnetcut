"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowRightDoubleIcon } from "@hugeicons/core-free-icons";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { useEditor } from "@/editor/use-editor";
import type { TimelineTrack } from "@/timeline";
import { getTrackCuts } from "@/transitions";
import { addTransitionAtCut } from "@/transitions/add-at-cut";

/** A clip's menu items for a transition at a cut on either side of it. */
export function TransitionMenuItems({
	track,
	elementId,
}: {
	track: TimelineTrack;
	elementId: string;
}) {
	const editor = useEditor();
	if (track.type !== "video") return null;

	const cuts = getTrackCuts({ track });
	const sides = [
		{
			label: "Add transition at start",
			cut: cuts.find(({ to }) => to.id === elementId),
		},
		{
			label: "Add transition at end",
			cut: cuts.find(({ from }) => from.id === elementId),
		},
	];

	return sides.map(
		({ label, cut }) =>
			cut && (
				<ContextMenuItem
					key={label}
					icon={<HugeiconsIcon icon={ArrowRightDoubleIcon} />}
					onClick={(event: React.MouseEvent) => {
						event.stopPropagation();
						addTransitionAtCut({ editor, cut });
					}}
				>
					{label}
				</ContextMenuItem>
			),
	);
}
