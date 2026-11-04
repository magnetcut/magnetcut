import {
	AddTrackCommand,
	BatchCommand,
	DeleteElementsCommand,
	InsertElementCommand,
	type Command,
} from "@/commands";
import type { EditorCore } from "@/core";
import type { MediaAsset } from "@/media/types";
import type { ParamValues } from "@/params";
import type { AudioTrack, RetimeConfig, SceneTracks } from "@/timeline";
import { toElementDurationTicks } from "@/timeline/creation";
import { buildElementFromMedia } from "@/timeline/element-utils";
import type { MediaTime } from "@/wasm";

/** A sound to put on the timeline: a take, or a cue spoken. */
export interface PlacedSound {
	asset: MediaAsset;
	startTime: MediaTime;
	/** On the timeline; the file's length if not given. */
	duration?: MediaTime;
	retime?: RetimeConfig;
	params?: ParamValues;
}

interface Span {
	start: number;
	end: number;
}

const overlaps = ({ a, b }: { a: Span; b: Span }) =>
	a.start < b.end && b.start < a.end;

/** The audio tracks called `name`, then "name 2", "name 3"…, in that order. */
export function findLanes({
	tracks,
	name,
}: {
	tracks: SceneTracks;
	name: string;
}): AudioTrack[] {
	const number = (track: AudioTrack) => {
		if (track.name === name) return 1;
		const match = track.name.match(/^(.*) (\d+)$/);
		return match && match[1] === name ? Number(match[2]) : null;
	};
	return tracks.audio
		.map((track) => ({ track, number: number(track) }))
		.filter(
			(lane): lane is { track: AudioTrack; number: number } =>
				lane.number !== null,
		)
		.sort((a, b) => a.number - b.number)
		.map(({ track }) => track);
}

/** Which lane each sound goes on: the first where it overlaps nothing. */
export function assignLanes({
	kept,
	sounds,
}: {
	/** What stays on each existing lane. */
	kept: Span[][];
	sounds: Span[];
}): number[] {
	const lanes = kept.map((spans) => [...spans]);
	return sounds.map((sound) => {
		let index = lanes.findIndex((spans) =>
			spans.every((span) => !overlaps({ a: span, b: sound })),
		);
		if (index === -1) {
			lanes.push([]);
			index = lanes.length - 1;
		}
		lanes[index].push(sound);
		return index;
	});
}

/**
 * Sounds put on the audio tracks called `trackName`, made if there are none,
 * in one step that Undo takes back. What they cover there is taken off (a new
 * take replaces the one it's over); sounds that overlap each other go on a
 * track below, "Voice-over 2".
 */
export function placeSounds({
	editor,
	trackName,
	sounds,
}: {
	editor: EditorCore;
	trackName: string;
	sounds: PlacedSound[];
}): void {
	if (sounds.length === 0) return;
	const built = sounds
		.map((sound) => {
			const element = buildElementFromMedia({
				mediaId: sound.asset.id,
				mediaType: "audio",
				name: sound.asset.name,
				duration:
					sound.duration ??
					toElementDurationTicks({ seconds: sound.asset.duration ?? 0 }),
				startTime: sound.startTime,
			});
			return {
				element: {
					...element,
					...(sound.retime ? { retime: sound.retime } : {}),
					params: { ...element.params, ...sound.params },
				},
				span: {
					start: element.startTime,
					end: element.startTime + element.duration,
				},
			};
		})
		.sort((a, b) => a.span.start - b.span.start);

	const lanes = findLanes({
		tracks: editor.scenes.getActiveScene().tracks,
		name: trackName,
	});
	const covered = lanes.flatMap((track) =>
		track.elements
			.filter((element) =>
				built.some(({ span }) =>
					overlaps({
						a: span,
						b: {
							start: element.startTime,
							end: element.startTime + element.duration,
						},
					}),
				),
			)
			.map((element) => ({ trackId: track.id, elementId: element.id })),
	);
	const removed = new Set(covered.map(({ elementId }) => elementId));
	const assigned = assignLanes({
		kept: lanes.map((track) =>
			track.elements
				.filter((element) => !removed.has(element.id))
				.map((element) => ({
					start: element.startTime,
					end: element.startTime + element.duration,
				})),
		),
		sounds: built.map(({ span }) => span),
	});

	const commands: Command[] = [];
	if (covered.length > 0) {
		commands.push(new DeleteElementsCommand({ elements: covered }));
	}
	const trackIds = lanes.map((track) => track.id);
	for (let lane = lanes.length; lane <= Math.max(...assigned); lane++) {
		const add = new AddTrackCommand({
			type: "audio",
			name: lane === 0 ? trackName : `${trackName} ${lane + 1}`,
		});
		commands.push(add);
		trackIds.push(add.getTrackId());
	}
	built.forEach(({ element }, index) => {
		commands.push(
			new InsertElementCommand({
				element,
				placement: { mode: "explicit", trackId: trackIds[assigned[index]] },
			}),
		);
	});
	editor.command.execute({ command: new BatchCommand(commands) });
}
