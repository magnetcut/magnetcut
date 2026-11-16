import {
	type FrameRate,
	transitionProgress,
	transitionWindow,
} from "magnetcut-wasm";
import { clampRetimeRate } from "@/retime/rate";
import type {
	ImageElement,
	Transition,
	VideoElement,
	VideoTrack,
} from "@/timeline";
import { mediaTimeFromSeconds, roundFrameTime } from "@/wasm";
import { DEFAULT_TRANSITION_SECONDS } from "./catalog";

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

type Clip = VideoElement | ImageElement;

function getOwnWindow({
	transition,
	from,
	to,
	taken = {},
}: {
	transition: Pick<Transition, "duration" | "alignment">;
	from: Clip;
	to: Clip;
	taken?: { from?: number; to?: number };
}): TransitionWindow | null {
	const window = transitionWindow({
		cut: to.startTime,
		duration: transition.duration,
		alignment: transition.alignment,
		fromHandle: getHandles({ element: from }).tail,
		toHandle: getHandles({ element: to }).head,
		fromDuration: from.duration,
		toDuration: to.duration,
		fromTaken: taken.from,
		toTaken: taken.to,
	});
	return window ?? null;
}

function isHidden({ element }: { element: Clip }) {
	return element.hidden === true;
}

/** Its clips, if it plays: both there and shown, touching. */
function getPlayingClips({
	transition,
	elements,
}: {
	transition: Transition;
	elements: Map<string, Clip>;
}): { from: Clip; to: Clip } | null {
	const from = elements.get(transition.fromElementId);
	const to = elements.get(transition.toElementId);
	if (
		!from ||
		!to ||
		isHidden({ element: from }) ||
		isHidden({ element: to }) ||
		from.startTime + from.duration !== to.startTime
	) {
		return null;
	}
	return { from, to };
}

/**
 * How much of the outgoing clip the transition at its start takes, and of the
 * incoming clip the one at its end, each as it would play by itself.
 */
function getTakenByNeighbours({
	transitions,
	elements,
	from,
	to,
}: {
	transitions: Transition[];
	elements: Map<string, Clip>;
	from: Clip;
	to: Clip;
}): { from?: number; to?: number } {
	const windowOf = (transition: Transition | undefined) => {
		const clips = transition && getPlayingClips({ transition, elements });
		return clips ? getOwnWindow({ transition, ...clips }) : null;
	};
	const before = windowOf(
		transitions.find(({ toElementId }) => toElementId === from.id),
	);
	const after = windowOf(
		transitions.find(({ fromElementId }) => fromElementId === to.id),
	);
	return {
		from: before ? Math.max(0, before.end - from.startTime) : undefined,
		to: after
			? Math.max(0, to.startTime + to.duration - after.start)
			: undefined,
	};
}

function mapClips({ track }: { track: VideoTrack }): Map<string, Clip> {
	return new Map(track.elements.map((element) => [element.id, element]));
}

/**
 * Where it plays, within the clips and their handles: null for no room. On
 * its track, it shares a clip with the transition at the clip's other end.
 */
export function getTransitionWindow({
	transition,
	from,
	to,
	track,
}: {
	transition: Pick<Transition, "duration" | "alignment">;
	from: Clip;
	to: Clip;
	track?: VideoTrack;
}): TransitionWindow | null {
	const taken = track
		? getTakenByNeighbours({
				transitions: track.transitions ?? [],
				elements: mapClips({ track }),
				from,
				to,
			})
		: {};
	return getOwnWindow({ transition, from, to, taken });
}

/** How long a new transition lasts: whole frames, when the rate is known. */
export function getDefaultTransitionDuration({
	fps,
}: {
	fps: FrameRate | null | undefined;
}): Transition["duration"] {
	const time = mediaTimeFromSeconds({ seconds: DEFAULT_TRANSITION_SECONDS });
	return fps ? roundFrameTime({ time, fps }) : time;
}

/**
 * Where a transition that long can play media past the cut: centred if both
 * clips have some, else on the side that does; null if neither has.
 */
export function getFittingAlignment({
	duration,
	from,
	to,
}: {
	duration: Transition["duration"];
	from: VideoElement | ImageElement;
	to: VideoElement | ImageElement;
}): Transition["alignment"] | null {
	const alignments = ["center", "end", "start"] as const;
	return (
		alignments.find(
			(alignment) =>
				getTransitionWindow({
					transition: { duration, alignment },
					from,
					to,
				}) !== null,
		) ?? null
	);
}

/**
 * A track's transitions that play: both clips there and shown, touching. Two
 * at the ends of one clip share it, so their windows never overlap.
 */
export function resolveTrackTransitions({
	track,
}: {
	track: VideoTrack;
}): ResolvedTransition[] {
	const transitions = track.transitions ?? [];
	if (!transitions.length) {
		return [];
	}
	const elements = mapClips({ track });
	const resolved: ResolvedTransition[] = [];
	for (const transition of transitions) {
		const clips = getPlayingClips({ transition, elements });
		if (!clips) {
			continue;
		}
		const taken = getTakenByNeighbours({ transitions, elements, ...clips });
		const window = getOwnWindow({ transition, ...clips, taken });
		if (window) {
			resolved.push({ transition, ...clips, window });
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
