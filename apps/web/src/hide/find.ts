import { RegionTracker } from "magnetcut-wasm";
import type { EditorCore } from "@/core";
import { frameRateToFloat } from "@/fps/utils";
import { upsertMaskKeyframes } from "@/masks/keyframes";
import { buildEffectElement } from "@/timeline/element-utils";
import { mediaTime, TICKS_PER_SECOND } from "@/wasm";
import { matchDetections, type Detection } from "./detect";
import { detect, type DetectorKind } from "./models";
import {
	HIDE_SHAPE_NAMES,
	buildHideRegionMask,
	type HIDE_LOOKS,
} from "./region";
import {
	openFrames,
	regionToMaskParams,
	type TrackFrame,
	type TrackRegion,
} from "./track";

// Faces or plates found in a clip, each followed through it as a Hide region
// of its own (docs/HIDE.md, phase 3): the model run every other frame, its
// finds joined across frames by how much they overlap, the tracker following
// in between and wherever the model misses one.

// Frames between two detections.
const DETECT_EVERY = 2;

// Frames a face or a plate may go unseen, neither found nor followed, before
// it's ended: turned away, or behind something, for a moment.
const LOST_FRAMES = 15;

// Frames a region stays before it's first seen and after it's last: better
// too long than a face showing.
const HOLD_FRAMES = 5;

// A face or a plate found fewer times is taken for a false find.
const MIN_FINDS = 3;

// Enough overlap to be the same one.
const SAME = 0.3;

// Below this, the tracker isn't sure: the track waits for a detection.
const MIN_CONFIDENCE = 0.5;

/** How much more than the box found the region covers: a face's hair and
 * ears, a plate's frame. */
const PADDING: Record<DetectorKind, number> = { faces: 1.35, plates: 1.15 };

interface Track {
	tracker: RegionTracker | null;
	positions: Map<number, TrackRegion>;
	region: TrackRegion;
	/** The frame it was last seen on. */
	lastSeen: number;
	/** How many times the model found it. */
	finds: number;
}

function toRegion({
	detection,
	padding,
}: {
	detection: Detection;
	padding: number;
}): TrackRegion {
	return {
		centerX: detection.x + detection.width / 2,
		centerY: detection.y + detection.height / 2,
		width: detection.width * padding,
		height: detection.height * padding,
	};
}

function toBox({ region }: { region: TrackRegion }): Detection {
	return {
		x: region.centerX - region.width / 2,
		y: region.centerY - region.height / 2,
		width: region.width,
		height: region.height,
		score: 1,
	};
}

function bytes({ frame }: { frame: TrackFrame }): Uint8Array {
	return new Uint8Array(
		frame.rgba.buffer,
		frame.rgba.byteOffset,
		frame.rgba.byteLength,
	);
}

function startTracker({
	frame,
	region,
}: {
	frame: TrackFrame;
	region: TrackRegion;
}): RegionTracker {
	return new RegionTracker(
		bytes({ frame }),
		frame.width,
		frame.height,
		region.centerX,
		region.centerY,
		region.width,
		region.height,
	);
}

/**
 * Finds the faces or plates in the selected clip's time (the timeline's, if
 * none is selected) and adds a Hide region for each, keyframed on every
 * frame it's found: how many it added.
 */
export async function findHideRegions({
	editor,
	kind,
	look,
	onProgress,
	isCancelled,
}: {
	editor: EditorCore;
	kind: DetectorKind;
	look: (typeof HIDE_LOOKS)[number];
	onProgress?: ({ progress }: { progress: number }) => void;
	isCancelled?: () => boolean;
}): Promise<{ added: number }> {
	const project = editor.project.getActiveOrNull();
	const frames = openFrames({ editor });
	if (!project || !frames) {
		return { added: 0 };
	}
	const { canvasSize, fps } = project.settings;
	const frameTicks = TICKS_PER_SECOND / frameRateToFloat(fps);
	const selected = editor.selection.getSelectedElements()[0];
	const element = selected
		? editor.timeline
				.getTrackById({ trackId: selected.trackId })
				?.elements.find((candidate) => candidate.id === selected.elementId)
		: undefined;
	const start = element?.startTime ?? 0;
	const end = element
		? element.startTime + element.duration
		: editor.timeline.getTotalDuration();
	const times: number[] = [];
	for (let time = start; time < end; time += frameTicks) {
		times.push(Math.round(time));
	}

	const tracks: Track[] = [];
	const stop = ({ track }: { track: Track }) => {
		track.tracker?.free();
		track.tracker = null;
	};
	try {
		for (const [index, time] of times.entries()) {
			if (isCancelled?.()) break;
			const frame = await frames.render({ time });
			const current = tracks.filter(
				(track) => index - track.lastSeen <= LOST_FRAMES,
			);
			const seen = new Set<Track>();
			if (index % DETECT_EVERY === 0) {
				const found = (await detect({ kind, frame })).map((detection) =>
					toRegion({ detection, padding: PADDING[kind] }),
				);
				const { pairs, unmatched } = matchDetections({
					known: current.map((track) => toBox({ region: track.region })),
					found: found.map((region) => toBox({ region })),
					threshold: SAME,
				});
				// Found again: the tracker starts over from there.
				for (const [trackIndex, findIndex] of pairs) {
					const track = current[trackIndex];
					const region = found[findIndex];
					track.tracker?.free();
					track.tracker = startTracker({ frame, region });
					track.region = region;
					track.finds += 1;
					seen.add(track);
				}
				for (const findIndex of unmatched) {
					const region = found[findIndex];
					const track: Track = {
						tracker: startTracker({ frame, region }),
						positions: new Map(),
						region,
						lastSeen: index,
						finds: 1,
					};
					tracks.push(track);
					seen.add(track);
				}
			}
			// Between detections, and where the model missed one: followed.
			for (const track of current) {
				if (seen.has(track) || !track.tracker) continue;
				const result = track.tracker.track(
					bytes({ frame }),
					frame.width,
					frame.height,
				);
				if (result.length >= 5 && result[4] >= MIN_CONFIDENCE) {
					track.region = {
						centerX: result[0],
						centerY: result[1],
						width: result[2],
						height: result[3],
					};
					seen.add(track);
				}
			}
			for (const track of seen) {
				track.lastSeen = index;
				track.positions.set(time, track.region);
			}
			for (const track of current) {
				if (!seen.has(track) && index - track.lastSeen >= LOST_FRAMES) {
					stop({ track });
				}
			}
			onProgress?.({ progress: (index + 1) / times.length });
		}
	} finally {
		for (const track of tracks) stop({ track });
	}

	// Each one followed long enough, as a Hide region of its own.
	const shape = kind === "faces" ? "face" : "plate";
	let added = 0;
	for (const track of tracks) {
		const keyed = [...track.positions.entries()].sort(([a], [b]) => a - b);
		if (track.finds < MIN_FINDS || keyed.length === 0) continue;
		// A little before it's first seen and after it's last.
		const first = Math.round(
			Math.max(start, keyed[0][0] - HOLD_FRAMES * frameTicks),
		);
		const last = Math.round(
			Math.min(
				end - frameTicks,
				keyed[keyed.length - 1][0] + HOLD_FRAMES * frameTicks,
			),
		);
		const mask = buildHideRegionMask({ shape, canvasSize });
		const effect = buildEffectElement({
			effectType: look.effectType,
			startTime: mediaTime({ ticks: first }),
			duration: mediaTime({
				ticks: Math.max(frameTicks, last - first + frameTicks),
			}),
		});
		let animations = effect.animations;
		for (const [time, region] of keyed) {
			animations = upsertMaskKeyframes({
				animations,
				mask,
				params: regionToMaskParams({ region, size: frames.size }),
				time: mediaTime({ ticks: time - first }),
			});
		}
		editor.timeline.insertElement({
			placement: { mode: "auto", trackType: "effect" },
			element: {
				...effect,
				name: `${look.name} ${HIDE_SHAPE_NAMES[shape].toLowerCase()} ${added + 1}`,
				params: { ...effect.params, ...look.params },
				masks: [mask],
				animations,
			},
		});
		added += 1;
	}
	return { added };
}
