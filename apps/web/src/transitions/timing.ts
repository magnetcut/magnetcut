import { transitionProgress, transitionWindow } from "magnetcut-wasm";
import { clampRetimeRate } from "@/retime/rate";
import type {
	ImageElement,
	Transition,
	VideoElement,
	VideoTrack,
} from "@/timeline";

export interface TransitionWindow {
	/** When it starts: before, the outgoing clip alone. */
	start: number;
	/** When it ends: from here, the incoming clip alone. */
	end: number;
	/** Shorter than its duration: the clips' handles allow no more. */
	clamped: boolean;
}

export interface ResolvedTransition {
	transition: Transition;
	from: VideoElement | ImageElement;
	to: VideoElement | ImageElement;
	window: TransitionWindow;
}

/**
 * How long a clip can start before its start (head) or go on past its end
 * (tail), on the timeline: what's trimmed off its media. None for images,
 * which have no end.
 */
function getHandles({ element }: { element: VideoElement | ImageElement }): {
	head?: number;
	tail?: number;
} {
	if (element.type !== "video") {
		return {};
	}
	const rate = clampRetimeRate({ rate: element.retime?.rate ?? 1 });
	return {
		head: Math.floor(element.trimStart / rate),
		tail: Math.floor(element.trimEnd / rate),
	};
}

/** Where it plays, within the clips and their handles: null for no room. */
export function getTransitionWindow({
	transition,
	from,
	to,
}: {
	transition: Transition;
	from: VideoElement | ImageElement;
	to: VideoElement | ImageElement;
}): TransitionWindow | null {
	const window = transitionWindow({
		cut: to.startTime,
		duration: transition.duration,
		alignment: transition.alignment,
		fromHandle: getHandles({ element: from }).tail,
		toHandle: getHandles({ element: to }).head,
		fromDuration: from.duration,
		toDuration: to.duration,
	});
	return window ?? null;
}

function isHidden({ element }: { element: VideoElement | ImageElement }) {
	return element.hidden === true;
}

/** A track's transitions that play: both clips there and shown, touching. */
export function resolveTrackTransitions({
	track,
}: {
	track: VideoTrack;
}): ResolvedTransition[] {
	if (!track.transitions?.length) {
		return [];
	}
	const elements = new Map(
		track.elements.map((element) => [element.id, element]),
	);
	const resolved: ResolvedTransition[] = [];
	for (const transition of track.transitions) {
		const from = elements.get(transition.fromElementId);
		const to = elements.get(transition.toElementId);
		if (
			!from ||
			!to ||
			isHidden({ element: from }) ||
			isHidden({ element: to }) ||
			from.startTime + from.duration !== to.startTime
		) {
			continue;
		}
		const window = getTransitionWindow({ transition, from, to });
		if (window) {
			resolved.push({ transition, from, to, window });
		}
	}
	return resolved;
}

/** From 0, the outgoing clip, to 1, the incoming one. */
export function getTransitionProgress({
	window,
	time,
}: {
	window: TransitionWindow;
	time: number;
}): number {
	return transitionProgress({
		start: window.start,
		end: window.end,
		time: Math.round(time),
	});
}
