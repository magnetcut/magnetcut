import { RegionTracker } from "magnetcut-wasm";
import type { EditorCore } from "@/core";
import { frameRateToFloat } from "@/fps/utils";
import { resolveMaskAtTime, upsertMaskKeyframes } from "@/masks/keyframes";
import type { Mask } from "@/masks/types";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import { buildScene } from "@/services/renderer/scene-builder";
import type { SceneTracks } from "@/timeline";
import { mediaTime, TICKS_PER_SECOND, type MediaTime } from "@/wasm";

// A Hide region followed through its frames (docs/HIDE.md, phase 2): what's
// inside it at the playhead found again on each frame after, then each
// before, by the region tracker (rust/crates/tracking), a keyframe for its
// place and size on every frame.

/** A frame to track in: RGBA, small. */
export interface TrackFrame {
	rgba: Uint8ClampedArray;
	width: number;
	height: number;
}

/** A region of a frame, in its pixels. */
export interface TrackRegion {
	centerX: number;
	centerY: number;
	width: number;
	height: number;
}

// Below this, a match isn't sure: the tracker loses the region on its own,
// lower; this stops before a doubtful frame is keyframed.
const MIN_CONFIDENCE = 0.5;

// The frames tracked are this wide at most: enough to follow a face, quick
// to render and match.
const TRACK_SIZE = 640;

/** A box mask's place and size, as a region of a frame `size`. */
export function maskToRegion({
	mask,
	size,
}: {
	mask: Mask;
	size: { width: number; height: number };
}): TrackRegion | null {
	if (mask.type !== "rectangle" && mask.type !== "ellipse") {
		return null;
	}
	const { centerX, centerY, width, height } = mask.params;
	return {
		centerX: (0.5 + centerX) * size.width,
		centerY: (0.5 + centerY) * size.height,
		width: width * size.width,
		height: height * size.height,
	};
}

/** A region of a frame `size` as a box mask's parameters. */
export function regionToMaskParams({
	region,
	size,
}: {
	region: TrackRegion;
	size: { width: number; height: number };
}): Record<string, number> {
	return {
		centerX: region.centerX / size.width - 0.5,
		centerY: region.centerY / size.height - 0.5,
		width: region.width / size.width,
		height: region.height / size.height,
	};
}

/**
 * The region on each next frame, until they end or it's lost: one entry for
 * each frame where it's found, in order.
 */
export async function followRegion({
	start,
	region,
	frames,
}: {
	start: TrackFrame;
	region: TrackRegion;
	frames: AsyncIterable<TrackFrame>;
}): Promise<{ found: TrackRegion[]; isLost: boolean }> {
	const tracker = new RegionTracker(
		new Uint8Array(
			start.rgba.buffer,
			start.rgba.byteOffset,
			start.rgba.byteLength,
		),
		start.width,
		start.height,
		region.centerX,
		region.centerY,
		region.width,
		region.height,
	);
	const found: TrackRegion[] = [];
	try {
		for await (const frame of frames) {
			const result = tracker.track(
				new Uint8Array(
					frame.rgba.buffer,
					frame.rgba.byteOffset,
					frame.rgba.byteLength,
				),
				frame.width,
				frame.height,
			);
			if (result.length < 5 || result[4] < MIN_CONFIDENCE) {
				return { found, isLost: true };
			}
			found.push({
				centerX: result[0],
				centerY: result[1],
				width: result[2],
				height: result[3],
			});
		}
		return { found, isLost: false };
	} finally {
		tracker.free();
	}
}

/** The timeline without its Hide regions: what they hide, as it is. */
function withoutHideRegions({ tracks }: { tracks: SceneTracks }): SceneTracks {
	return {
		...tracks,
		overlay: tracks.overlay.map((track) =>
			track.type !== "effect"
				? track
				: {
						...track,
						elements: track.elements.filter(
							(element) => (element.masks?.length ?? 0) === 0,
						),
					},
		),
	};
}

export interface TrackResult {
	/** Frames keyframed. */
	frames: number;
	/** Where, in the timeline's time, the region was lost: going forward, and
	 * going back; none where it was followed to the region's end. */
	lostForward: MediaTime | null;
	lostBack: MediaTime | null;
}

/**
 * Tracks a Hide region from the playhead to its end and back to its start,
 * writing a keyframe of its mask's place and size on every frame it's found.
 */
export async function trackHideRegion({
	editor,
	trackId,
	elementId,
	onProgress,
	isCancelled,
}: {
	editor: EditorCore;
	trackId: string;
	elementId: string;
	onProgress?: ({ progress }: { progress: number }) => void;
	isCancelled?: () => boolean;
}): Promise<TrackResult | null> {
	const project = editor.project.getActiveOrNull();
	const tracks = editor.scenes.getActiveScene().tracks;
	const element = tracks.overlay
		.find((track) => track.id === trackId)
		?.elements.find((candidate) => candidate.id === elementId);
	if (!project || element?.type !== "effect" || !element.masks?.[0]) {
		return null;
	}
	const baseMask = element.masks[0];
	const { canvasSize, fps, background } = project.settings;
	const scale = Math.min(
		1,
		TRACK_SIZE / Math.max(canvasSize.width, canvasSize.height),
	);
	const size = {
		width: Math.max(16, Math.round(canvasSize.width * scale)),
		height: Math.max(16, Math.round(canvasSize.height * scale)),
	};

	const scene = buildScene({
		tracks: withoutHideRegions({ tracks }),
		mediaAssets: editor.media.getAssets(),
		duration: editor.timeline.getTotalDuration(),
		canvasSize,
		background,
	});
	const renderer = new CanvasRenderer({ ...canvasSize, fps });
	const full = document.createElement("canvas");
	full.width = canvasSize.width;
	full.height = canvasSize.height;
	const small = document.createElement("canvas");
	small.width = size.width;
	small.height = size.height;
	const context = small.getContext("2d", { willReadFrequently: true });
	if (!context) {
		return null;
	}
	const render = async ({ time }: { time: number }): Promise<TrackFrame> => {
		await renderer.renderToCanvas({ node: scene, time, targetCanvas: full });
		context.drawImage(full, 0, 0, size.width, size.height);
		const { data } = context.getImageData(0, 0, size.width, size.height);
		return { rgba: data, ...size };
	};

	// Each frame's time, from the playhead (within the region) on.
	const frameTicks = TICKS_PER_SECOND / frameRateToFloat(fps);
	const start = element.startTime;
	const end = element.startTime + element.duration;
	const playhead = Math.min(
		Math.max(editor.playback.getCurrentTime(), start),
		end - 1,
	);
	const forward: number[] = [];
	for (let time = playhead + frameTicks; time < end; time += frameTicks) {
		forward.push(Math.round(time));
	}
	const back: number[] = [];
	for (let time = playhead - frameTicks; time >= start; time -= frameTicks) {
		back.push(Math.round(time));
	}
	const total = Math.max(1, forward.length + back.length);
	let done = 0;

	const localTime = (time: number) =>
		mediaTime({ ticks: Math.max(0, time - start) });
	const mask = resolveMaskAtTime({
		mask: baseMask,
		animations: element.animations,
		localTime: localTime(playhead),
	});
	const region = maskToRegion({ mask, size });
	if (!region) {
		return null;
	}
	const first = await render({ time: playhead });
	const framesAt = async function* ({ times }: { times: number[] }) {
		for (const time of times) {
			if (isCancelled?.()) return;
			yield await render({ time });
			done += 1;
			onProgress?.({ progress: done / total });
		}
	};

	const ahead = await followRegion({
		start: first,
		region,
		frames: framesAt({ times: forward }),
	});
	const behind = isCancelled?.()
		? { found: [], isLost: false }
		: await followRegion({
				start: first,
				region,
				frames: framesAt({ times: back }),
			});

	// Every frame found, and the playhead's, keyframed in one change.
	let animations = upsertMaskKeyframes({
		animations: element.animations,
		mask: baseMask,
		params: regionToMaskParams({ region, size }),
		time: localTime(playhead),
	});
	const keyed = [
		...ahead.found.map((found, index) => ({ found, time: forward[index] })),
		...behind.found.map((found, index) => ({ found, time: back[index] })),
	];
	for (const { found, time } of keyed) {
		animations = upsertMaskKeyframes({
			animations,
			mask: baseMask,
			params: regionToMaskParams({ region: found, size }),
			time: localTime(time),
		});
	}
	editor.timeline.updateElements({
		updates: [{ trackId, elementId, patch: { animations } }],
	});
	return {
		frames: keyed.length + 1,
		lostForward: ahead.isLost
			? mediaTime({ ticks: forward[ahead.found.length] })
			: null,
		lostBack: behind.isLost
			? mediaTime({ ticks: back[behind.found.length] })
			: null,
	};
}
