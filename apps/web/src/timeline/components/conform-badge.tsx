"use client";

import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { useConformStore } from "@/export/fast/conform-store";

/**
 * The "!" on a main-track clip whose file keeps Fast mode from joining the
 * clips (docs/CONFORM.md): it says how, and opens the dialog that converts
 * them. Only while Fast mode is the Export mode chosen.
 */
export function ConformBadge({ mediaId }: { mediaId: string }) {
	const difference = useConformStore((state) => state.odd.get(mediaId));
	const openDialog = useConformStore((state) => state.openDialog);
	if (!difference) return null;
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					aria-label="This clip's file is unlike the others: make the clips match"
					className="absolute top-1 right-1 z-20 flex size-4 items-center justify-center rounded-full bg-amber-400 text-[0.65rem] leading-none font-bold text-black shadow-sm ring-1 ring-black/20 hover:bg-amber-300"
					onMouseDown={(event) => event.stopPropagation()}
					onClick={(event) => {
						event.stopPropagation();
						openDialog();
					}}
				>
					!
				</button>
			</TooltipTrigger>
			<TooltipContent className="max-w-64">
				{`${difference}: Fast mode can't join it to the other clips as it is. Click to make the clips match.`}
			</TooltipContent>
		</Tooltip>
	);
}
