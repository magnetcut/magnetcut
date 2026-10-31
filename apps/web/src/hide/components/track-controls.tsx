"use client";

import { useRef, useState } from "react";
import { formatTimecode } from "magnetcut-wasm";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { SectionField } from "@/components/section";
import { useEditor } from "@/editor/use-editor";
import { trackHideRegion, type TrackResult } from "@/hide/track";

/** Track: a Hide region followed from the playhead to its end and back to
 * its start, a keyframe on each frame (docs/HIDE.md, phase 2). */
export function TrackControls({
	trackId,
	elementId,
}: {
	trackId: string;
	elementId: string;
}) {
	const editor = useEditor();
	const [progress, setProgress] = useState<number | null>(null);
	const [result, setResult] = useState<TrackResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const cancelled = useRef(false);

	const start = async () => {
		cancelled.current = false;
		setResult(null);
		setError(null);
		setProgress(0);
		try {
			const tracked = await trackHideRegion({
				editor,
				trackId,
				elementId,
				onProgress: ({ progress: done }) => setProgress(done),
				isCancelled: () => cancelled.current,
			});
			if (!tracked) {
				setError("Only an oval or a rectangle can be tracked.");
			}
			setResult(tracked);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setProgress(null);
		}
	};

	const rate = editor.project.getActiveOrNull()?.settings.fps;
	const at = (time: TrackResult["lostForward"]) =>
		time === null ? "" : (formatTimecode({ time, rate }) ?? "");

	return (
		<SectionField label="Follow what's inside">
			{progress === null ? (
				<Button size="sm" variant="secondary" onClick={() => void start()}>
					Track from the playhead
				</Button>
			) : (
				<div className="flex items-center gap-2">
					<Progress value={progress * 100} className="flex-1" />
					<Button
						size="sm"
						variant="ghost"
						onClick={() => {
							cancelled.current = true;
						}}
					>
						Stop
					</Button>
				</div>
			)}
			{result ? (
				<p className="text-muted-foreground text-xs">
					{`Followed over ${result.frames} frames.`}
					{result.lostForward !== null
						? ` Lost at ${at(result.lostForward)}: place it there and track again.`
						: ""}
					{result.lostBack !== null
						? ` Lost going back at ${at(result.lostBack)}.`
						: ""}
				</p>
			) : null}
			{error ? <p className="text-destructive text-xs">{error}</p> : null}
			<p className="text-muted-foreground text-xs">
				Place the region on the face or plate first. Check the result frame by
				frame: a frame it misses shows what&apos;s under it.
			</p>
		</SectionField>
	);
}
