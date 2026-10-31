import type { MediaAsset } from "@/media/types";
import type {
	SceneTracks,
	TimelineElement,
	TimelineTrack,
	Transition,
} from "@/timeline";
import { TICKS_PER_SECOND } from "@/wasm";
import { shortIds } from "./ids";
import { formatTime } from "./time";

// The project as an agent reads it (docs/AUTOMATION.md): a few short lines,
// what's there and where, only what's set; and one thing's every detail, on
// request.

export interface SummaryInput {
	name: string;
	canvasSize: { width: number; height: number };
	fps: number;
	duration: number;
	revision: string;
	assets: MediaAsset[];
	tracks: SceneTracks;
}

/** The tracks in the order they're shown, top first, each with its name. */
export function namedTracks({
	tracks,
}: {
	tracks: SceneTracks;
}): Array<{ name: string; track: TimelineTrack }> {
	const counts: Record<string, number> = { V: 1 };
	const letter = (track: TimelineTrack) =>
		({ video: "V", text: "T", audio: "A", graphic: "G", effect: "E" })[
			track.type
		];
	const name = (track: TimelineTrack) => {
		const key = letter(track);
		counts[key] = (counts[key] ?? 0) + 1;
		return `${key}${counts[key]}`;
	};
	const overlay = tracks.overlay.map((track) => ({
		name: name(track),
		track: track as TimelineTrack,
	}));
	return [
		...overlay,
		{ name: "V1", track: tracks.main },
		...tracks.audio.map((track) => ({ name: name(track), track })),
	];
}

/** Every id an agent can name: elements, tracks' transitions and media. */
export function allIds({
	tracks,
	assets,
}: {
	tracks: SceneTracks;
	assets: MediaAsset[];
}): string[] {
	const ids: string[] = assets.map((asset) => asset.id);
	for (const { track } of namedTracks({ tracks })) {
		for (const element of track.elements) ids.push(element.id);
	}
	return ids;
}

function quoted({ text, limit }: { text: string; limit: number }): string {
	const line = text.replace(/\s+/g, " ").trim();
	return JSON.stringify(
		line.length > limit ? `${line.slice(0, limit - 1)}…` : line,
	);
}

function span({ element }: { element: TimelineElement }): string {
	return `${formatTime({ ticks: element.startTime })}-${formatTime({
		ticks: element.startTime + element.duration,
	})}`;
}

function describeShort({
	element,
	short,
}: {
	element: TimelineElement;
	short: Map<string, string>;
}): string {
	const parts = [short.get(element.id) ?? element.id];
	switch (element.type) {
		case "video":
		case "image":
			parts.push(short.get(element.mediaId) ?? "?", span({ element }));
			break;
		case "audio":
			parts.push(
				element.sourceType === "upload"
					? (short.get(element.mediaId) ?? "?")
					: "library",
				span({ element }),
			);
			break;
		case "text":
			parts.push(
				quoted({ text: String(element.params.content ?? ""), limit: 30 }),
				span({ element }),
			);
			break;
		case "sticker":
			parts.push(`sticker ${element.stickerId}`, span({ element }));
			break;
		case "graphic":
			parts.push(`graphic ${element.definitionId}`, span({ element }));
			break;
		case "effect":
			parts.push(element.effectType, span({ element }));
			if (element.masks?.length) parts.push("in a mask");
			break;
	}
	if (
		(element.type === "video" || element.type === "audio") &&
		(element.trimStart > 0 || element.trimEnd > 0)
	) {
		const rate = element.retime?.rate ?? 1;
		parts.push(
			`src ${formatTime({ ticks: element.trimStart })}-${formatTime({
				ticks: element.trimStart + element.duration * rate,
			})}`,
		);
	}
	if (
		(element.type === "video" || element.type === "audio") &&
		element.retime &&
		element.retime.rate !== 1
	) {
		parts.push(`x${+element.retime.rate.toFixed(3)}`);
	}
	if ("hidden" in element && element.hidden) parts.push("hidden");
	if (element.type === "video" && element.isSourceAudioEnabled === false) {
		parts.push("no sound");
	}
	if (element.animations && Object.keys(element.animations).length > 0) {
		parts.push("keyframed");
	}
	return parts.join(" ");
}

function transitionAfter({
	element,
	transitions,
}: {
	element: TimelineElement;
	transitions: Transition[] | undefined;
}): string {
	const transition = transitions?.find(
		(candidate) => candidate.fromElementId === element.id,
	);
	return transition
		? ` >${transition.type} ${+(transition.duration / TICKS_PER_SECOND).toFixed(2)}`
		: "";
}

/** The project in a few lines. */
export function buildSummary(input: SummaryInput): string {
	const { assets, tracks } = input;
	const short = shortIds({ ids: allIds({ tracks, assets }) });
	const lines = [
		`${JSON.stringify(input.name)} ${input.canvasSize.width}x${input.canvasSize.height} ${+input.fps.toFixed(3)}fps ${formatTime({ ticks: input.duration })} rev ${input.revision}`,
	];
	if (assets.length > 0) {
		lines.push(
			`media ${assets
				.map((asset) =>
					[
						short.get(asset.id),
						asset.name,
						asset.duration
							? formatTime({ ticks: asset.duration * TICKS_PER_SECOND })
							: "",
						asset.width && asset.height ? `${asset.width}x${asset.height}` : "",
						asset.type === "video" && asset.hasAudio === false
							? "no sound"
							: "",
					]
						.filter(Boolean)
						.join(" "),
				)
				.join(" | ")}`,
		);
	} else {
		lines.push("media none");
	}
	for (const { name, track } of namedTracks({ tracks })) {
		if (track.elements.length === 0) continue;
		const flags = [
			"muted" in track && track.muted ? "muted" : "",
			"hidden" in track && track.hidden ? "hidden" : "",
		]
			.filter(Boolean)
			.map((flag) => ` (${flag})`)
			.join("");
		if (track.type === "text" && track.subtitles) {
			const first = track.elements[0];
			const last = track.elements[track.elements.length - 1];
			lines.push(
				`${name}${flags} subtitles ${track.elements.length} lines ${formatTime({ ticks: first.startTime })}-${formatTime({ ticks: last.startTime + last.duration })}`,
			);
			continue;
		}
		const transitions = track.type === "video" ? track.transitions : undefined;
		lines.push(
			`${name}${flags} ${track.elements
				.map(
					(element) =>
						describeShort({ element, short }) +
						transitionAfter({ element, transitions }),
				)
				.join(" | ")}`,
		);
	}
	if (tracks.main.elements.length === 0 && tracks.overlay.length === 0) {
		lines.push("timeline empty");
	}
	return lines.join("\n");
}

/** Everything about the thing an agent named: an element, a track (a
 * subtitle track's lines too) or a medium; null if it's none of them. */
export function describe({
	id,
	input,
}: {
	id: string;
	input: SummaryInput;
}): string | null {
	const { tracks, assets } = input;
	const ids = allIds({ tracks, assets });
	const short = shortIds({ ids });
	const named = namedTracks({ tracks });
	const track = named.find(({ name }) => name === id.toUpperCase());
	if (track) {
		return track.track.elements
			.map((element) =>
				track.track.type === "text" && track.track.subtitles
					? `${short.get(element.id)} ${span({ element })} ${quoted({ text: String(element.params.content ?? ""), limit: 200 })}`
					: describeShort({ element, short }),
			)
			.join("\n");
	}
	const full = ids.filter((candidate) => candidate.startsWith(id));
	if (full.length !== 1) return null;
	const asset = assets.find((candidate) => candidate.id === full[0]);
	if (asset) {
		const { file: _file, url: _url, thumbnailUrl: _thumbnail, ...rest } = asset;
		return JSON.stringify({ ...rest, id: short.get(asset.id) }, null, 1);
	}
	for (const { name, track: candidate } of named) {
		const element = candidate.elements.find((one) => one.id === full[0]);
		if (!element) continue;
		const { id: _id, ...detail } = element as TimelineElement & {
			buffer?: unknown;
		};
		delete (detail as { buffer?: unknown }).buffer;
		return `${short.get(element.id)} on ${name}, ${span({ element })}\n${JSON.stringify(
			detail,
			(key, value: unknown) =>
				key === "startTime" ||
				key === "duration" ||
				key === "trimStart" ||
				key === "trimEnd" ||
				key === "sourceDuration"
					? typeof value === "number"
						? formatTime({ ticks: value })
						: value
					: value,
			1,
		)}`;
	}
	return null;
}

/** What a batch of edits changed, in the summary's terms: `- id` gone,
 * `+ track line` new, `~ track line (was …)` changed. */
export function diffTracks({
	before,
	after,
	assets,
}: {
	before: SceneTracks;
	after: SceneTracks;
	assets: MediaAsset[];
}): string {
	const short = shortIds({
		ids: [
			...new Set([
				...allIds({ tracks: before, assets }),
				...allIds({ tracks: after, assets }),
			]),
		],
	});
	const lines = ({ tracks }: { tracks: SceneTracks }) => {
		const found = new Map<string, string>();
		for (const { name, track } of namedTracks({ tracks })) {
			const transitions =
				track.type === "video" ? track.transitions : undefined;
			for (const element of track.elements) {
				found.set(
					element.id,
					`${name} ${describeShort({ element, short })}${transitionAfter({ element, transitions })}`,
				);
			}
		}
		return found;
	};
	const was = lines({ tracks: before });
	const now = lines({ tracks: after });
	const changes: string[] = [];
	for (const id of was.keys()) {
		if (!now.has(id)) changes.push(`- ${short.get(id) ?? id}`);
	}
	for (const [id, line] of now) {
		const old = was.get(id);
		if (old === undefined) changes.push(`+ ${line}`);
		else if (old !== line) changes.push(`~ ${line} (was ${old})`);
	}
	return changes.length > 0 ? changes.join("\n") : "no change";
}
