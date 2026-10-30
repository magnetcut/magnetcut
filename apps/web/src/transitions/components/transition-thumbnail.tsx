"use client";

import { useEffect, useRef } from "react";
import { transitionPreviewService } from "@/services/renderer/transition-preview";
import type { TransitionDefinition } from "@/transitions";

// Where the still shows it: early, before a dip reaches its color.
const STILL_PROGRESS = 0.3;
// On hover it plays, holds the end, and plays again.
const PLAY_MS = 1200;
const HOLD_MS = 500;

/** A transition between two sample images: a still, played on hover. */
export function TransitionThumbnail({
	definition,
}: {
	definition: TransitionDefinition;
}) {
	const canvasRef = useRef<HTMLCanvasElement>(null);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		let frame = 0;
		let isReady = false;
		let isDisposed = false;

		const draw = ({ progress }: { progress: number }) =>
			transitionPreviewService.render({ definition, progress, target: canvas });
		const showStill = () => {
			cancelAnimationFrame(frame);
			if (isReady) draw({ progress: STILL_PROGRESS });
		};
		const play = () => {
			if (!isReady) return;
			const start = performance.now();
			const tick = (now: number) => {
				const elapsed = (now - start) % (PLAY_MS + HOLD_MS);
				draw({ progress: Math.min(1, elapsed / PLAY_MS) });
				frame = requestAnimationFrame(tick);
			};
			frame = requestAnimationFrame(tick);
		};

		transitionPreviewService
			.ready()
			.then(() => {
				if (isDisposed) return;
				isReady = true;
				showStill();
			})
			.catch((error: unknown) => {
				console.warn("Transition previews unavailable", error);
			});

		// The card around it, so its add button counts as hovering too.
		const host = canvas.parentElement ?? canvas;
		host.addEventListener("mouseenter", play);
		host.addEventListener("mouseleave", showStill);
		return () => {
			isDisposed = true;
			cancelAnimationFrame(frame);
			host.removeEventListener("mouseenter", play);
			host.removeEventListener("mouseleave", showStill);
		};
	}, [definition]);

	return <canvas ref={canvasRef} className="size-full" />;
}
