"use client";

import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useEditor } from "@/editor/use-editor";
import { VOLUME_DB_MIN } from "@/timeline/audio-constants";
import { getDbFromLinePos, getLinePosFromDb } from "@/timeline/audio-display";
import {
	FADE_MAX_SECONDS,
	FADE_SILENCE_DB,
	getFadeFloor,
	getFadeShape,
	readClipFades,
} from "@/timeline/audio-fades";
import { getElementVolume } from "@/timeline/audio-state";
import type { AudioElement } from "@/timeline/types";
import { clamp, snapToStep } from "@/utils/math";
import { cn } from "@/utils/ui";
import { TICKS_PER_SECOND } from "@/wasm";

/*
 * A clip's fades on its volume line (timeline/audio-fades.ts): at each end a
 * point dragged in along the line for the fade's length, and once there's a
 * fade one at the clip's edge dragged up or down for the level it starts
 * from or ends at, silence at the bottom. A point at an end with no fade
 * dragged down makes one, a second long.
 */

type Side = "in" | "out";
type Mode = "length" | "level";

// The points sit this far in from the clip's edges, clear of its trim handles.
const EDGE_INSET_PX = 7;
// A drag starts once it has gone this far.
const DRAG_THRESHOLD_PX = 3;
// The fade a point at an end with none makes when dragged down.
const NEW_FADE_SECONDS = 1;
const CURVE_POINTS = 24;
const TOOLTIP_OFFSET_PX = 10;
const MINUS = "−";

const PARAM_KEYS = {
	in: { length: "fadeIn", level: "fadeInLevel" },
	out: { length: "fadeOut", level: "fadeOutLevel" },
} as const;

/** A point's height, kept whole inside the clip. */
function within({ percent }: { percent: number }): string {
	return `clamp(5px, ${percent}%, calc(100% - 5px))`;
}

function formatLevel({ db }: { db: number }): string {
	return db <= FADE_SILENCE_DB
		? "silence"
		: `${db < 0 ? MINUS : ""}${Math.abs(db).toFixed(1)} dB`;
}

export function AudioFadeHandles({
	element,
	trackId,
}: {
	element: AudioElement;
	trackId: string;
}) {
	const editor = useEditor();
	const surfaceRef = useRef<HTMLDivElement>(null);
	const drag = useRef<{
		pointerId: number;
		side: Side;
		mode: Mode | null;
		startX: number;
		startY: number;
		startLength: number;
		changed: boolean;
	} | null>(null);
	const [tooltip, setTooltip] = useState<{
		x: number;
		y: number;
		text: string;
	} | null>(null);

	const fps = useEditor((e) => e.project.getActiveOrNull()?.settings.fps);
	const duration = element.duration / TICKS_PER_SECOND;
	if (duration <= 0) return null;
	// Lengths snap to the project's frames.
	const frameSeconds = fps ? fps.denominator / fps.numerator : 0.01;
	const volume = getElementVolume({ element });
	const lineY = getLinePosFromDb({ db: volume });
	const fades = readClipFades({ element });
	const lengths = { in: fades?.in ?? 0, out: fades?.out ?? 0 };
	const readLevel = (side: Side) => {
		const value = element.params[PARAM_KEYS[side].level];
		return typeof value === "number" ? value : FADE_SILENCE_DB;
	};

	// The volume line's height, in percent, at a gain on top of the volume.
	const yAtGain = (gain: number) =>
		getLinePosFromDb({
			db: gain <= 0 ? VOLUME_DB_MIN : volume + 20 * Math.log10(gain),
		});

	const curve = (side: Side) => {
		const length = lengths[side];
		const floor = getFadeFloor({ db: readLevel(side) });
		const points = Array.from({ length: CURVE_POINTS + 1 }, (_, index) => {
			const progress = index / CURVE_POINTS;
			const time = progress * length;
			const x = ((side === "in" ? time : duration - time) / duration) * 100;
			const gain = floor + (1 - floor) * getFadeShape({ progress });
			return { x, y: yAtGain(gain) };
		});
		const line = points.map(({ x, y }) => `${x},${y}`).join(" ");
		// Between the volume line and the curve, the sound faded away, shaded.
		const shade = `${points.map(({ x }) => `${x},${lineY}`).join(" ")} ${[
			...points,
		]
			.reverse()
			.map(({ x, y }) => `${x},${y}`)
			.join(" ")}`;
		return { line, shade };
	};

	const write = (values: Record<string, number>) => {
		if (drag.current) drag.current.changed = true;
		editor.timeline.previewElements({
			updates: [
				{
					trackId,
					elementId: element.id,
					updates: { params: { ...element.params, ...values } },
				},
			],
		});
	};

	const maxLength = (side: Side) =>
		Math.max(
			0,
			Math.min(
				FADE_MAX_SECONDS,
				duration - lengths[side === "in" ? "out" : "in"],
			),
		);

	const handlePointerDown = ({
		event,
		side,
		mode,
	}: {
		event: React.PointerEvent<HTMLDivElement>;
		side: Side;
		mode: Mode | null;
	}) => {
		if (event.button !== 0) return;
		event.preventDefault();
		event.stopPropagation();
		editor.selection.setSelectedElements({
			elements: [{ trackId, elementId: element.id }],
		});
		event.currentTarget.setPointerCapture(event.pointerId);
		drag.current = {
			pointerId: event.pointerId,
			side,
			mode,
			startX: event.clientX,
			startY: event.clientY,
			startLength: lengths[side],
			changed: false,
		};
	};

	const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
		const current = drag.current;
		const rect = surfaceRef.current?.getBoundingClientRect();
		if (!current || current.pointerId !== event.pointerId || !rect) return;
		event.preventDefault();
		const dx = event.clientX - current.startX;
		const dy = event.clientY - current.startY;
		if (current.mode === null) {
			if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
			// From an end with no fade: down makes one, along sets its length.
			current.mode = dy > Math.abs(dx) ? "level" : "length";
		}
		const { side } = current;
		const keys = PARAM_KEYS[side];
		let text: string;
		if (current.mode === "length") {
			const offset =
				side === "in" ? event.clientX - rect.left : rect.right - event.clientX;
			const length = clamp({
				value:
					Math.round(((offset / rect.width) * duration) / frameSeconds) *
					frameSeconds,
				min: 0,
				max: maxLength(side),
			});
			write({ [keys.length]: length });
			text = `Fade ${side} ${length.toFixed(2)} s`;
		} else {
			const percent = ((event.clientY - rect.top) / rect.height) * 100;
			const db = getDbFromLinePos({ percent }) - volume;
			const level =
				db <= FADE_SILENCE_DB + 0.5
					? FADE_SILENCE_DB
					: clamp({
							value: snapToStep({ value: db, step: 0.5 }),
							min: FADE_SILENCE_DB,
							max: 0,
						});
			write({
				[keys.level]: level,
				...(current.startLength > 0
					? {}
					: {
							[keys.length]: Math.min(NEW_FADE_SECONDS, maxLength(side) / 2),
						}),
			});
			text = `${side === "in" ? "From" : "To"} ${formatLevel({ db: level })}`;
		}
		setTooltip({
			x: event.clientX + TOOLTIP_OFFSET_PX,
			y: event.clientY - TOOLTIP_OFFSET_PX,
			text,
		});
	};

	const finish = ({ shouldCommit }: { shouldCommit: boolean }) => {
		const current = drag.current;
		drag.current = null;
		setTooltip(null);
		if (!current) return;
		if (shouldCommit && current.changed) {
			editor.timeline.commitPreview();
		} else if (current.changed) {
			editor.timeline.discardPreview();
		}
	};

	const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
		if (drag.current?.pointerId !== event.pointerId) return;
		event.preventDefault();
		event.stopPropagation();
		finish({ shouldCommit: true });
	};

	const removeFade = (side: Side) => {
		editor.timeline.updateElements({
			updates: [
				{
					trackId,
					elementId: element.id,
					patch: {
						params: { ...element.params, [PARAM_KEYS[side].length]: 0 },
					},
				},
			],
		});
	};

	const pointHandlers = {
		onPointerMove: handlePointerMove,
		onPointerUp: handlePointerUp,
		onPointerCancel: () => finish({ shouldCommit: false }),
		onLostPointerCapture: () => finish({ shouldCommit: true }),
		onMouseDown: (event: React.MouseEvent) => event.stopPropagation(),
		onClick: (event: React.MouseEvent) => {
			event.preventDefault();
			event.stopPropagation();
		},
	};

	return (
		<div ref={surfaceRef} className="pointer-events-none absolute inset-0">
			<svg
				viewBox="0 0 100 100"
				preserveAspectRatio="none"
				className="absolute inset-0 size-full overflow-visible"
				aria-hidden
			>
				{(["in", "out"] as const)
					.filter((side) => lengths[side] > 0)
					.map((side) => {
						const { line, shade } = curve(side);
						return (
							<g key={side}>
								<polygon points={shade} className="fill-black/35" />
								<polyline
									points={line}
									fill="none"
									className="stroke-white"
									strokeWidth={1}
									vectorEffect="non-scaling-stroke"
								/>
							</g>
						);
					})}
			</svg>
			{(["in", "out"] as const).map((side) => {
				const length = lengths[side];
				const hasFade = length > 0;
				const lengthX = (length / duration) * 100;
				const edgeStyle =
					side === "in"
						? { left: `${EDGE_INSET_PX}px` }
						: { right: `${EDGE_INSET_PX}px` };
				const lengthStyle =
					side === "in"
						? { left: `max(${EDGE_INSET_PX}px, ${lengthX}%)` }
						: { right: `max(${EDGE_INSET_PX}px, ${lengthX}%)` };
				const name = side === "in" ? "Fade in" : "Fade out";
				return (
					<div key={side}>
						{hasFade && (
							<div
								className="pointer-events-auto absolute z-10 size-2.5 cursor-ns-resize touch-none rounded-full border border-white bg-black/60"
								style={{
									...edgeStyle,
									top: within({
										percent: yAtGain(getFadeFloor({ db: readLevel(side) })),
									}),
									transform: `translate(${side === "in" ? "-50%" : "50%"}, -50%)`,
								}}
								title={`${name}: drag up or down for the level it ${side === "in" ? "starts from" : "ends at"}`}
								onPointerDown={(event) =>
									handlePointerDown({ event, side, mode: "level" })
								}
								{...pointHandlers}
							/>
						)}
						<div
							className={cn(
								"pointer-events-auto absolute z-10 size-2.5 cursor-ew-resize touch-none border border-white bg-black/60 transition-opacity",
								!hasFade && "opacity-0 group-hover/audio:opacity-100",
							)}
							style={{
								...lengthStyle,
								top: within({ percent: lineY }),
								transform: `translate(${side === "in" ? "-50%" : "50%"}, -50%) rotate(45deg)`,
							}}
							title={`${name}: drag along for its length, down to make one; double-click to take it off`}
							onPointerDown={(event) =>
								handlePointerDown({
									event,
									side,
									mode: hasFade ? "length" : null,
								})
							}
							onDoubleClick={(event) => {
								event.stopPropagation();
								if (hasFade) removeFade(side);
							}}
							{...pointHandlers}
						/>
					</div>
				);
			})}
			{tooltip &&
				createPortal(
					<div
						className="pointer-events-none fixed top-0 left-0 z-50 -translate-y-full rounded bg-black/75 px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap text-white"
						style={{
							transform: `translate(${tooltip.x}px, ${tooltip.y}px)`,
						}}
					>
						{tooltip.text}
					</div>,
					document.body,
				)}
		</div>
	);
}
