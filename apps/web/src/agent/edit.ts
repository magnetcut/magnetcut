import { TracksSnapshotCommand } from "@/commands/timeline/tracks-snapshot";
import type { EditorCore } from "@/core";
import { frameRateToFloat } from "@/fps/utils";
import type { TimelineElement, TimelineTrack } from "@/timeline";
import { DEFAULT_NEW_ELEMENT_DURATION } from "@/timeline/creation";
import {
	buildElementFromMedia,
	buildTextElement,
} from "@/timeline/element-utils";
import { DEFAULT_TRANSITION_TYPE } from "@/transitions/catalog";
import { mediaTime, mediaTimeFromSeconds } from "@/wasm";
import { resolveId } from "./ids";
import { allIds, diffTracks, namedTracks } from "./summary";
import { parseTime } from "./time";
import { revisionOf, ToolError, type Tool } from "./tools-base";

// `edit` (docs/AUTOMATION.md): a batch of operations on the open project, done
// in order with the editor's own commands, then folded into one step of undo.
// A dry run, or an operation that fails, puts everything back. The answer is
// what changed, in the summary's terms, not the project again.

type Operation = Record<string, unknown>;

interface Scope {
	editor: EditorCore;
	fps: number;
}

function tracksOf({ editor }: { editor: EditorCore }) {
	return editor.scenes.getActiveScene().tracks;
}

function time({
	scope,
	value,
	key,
}: {
	scope: Scope;
	value: unknown;
	key: string;
}): number {
	const ticks = parseTime({ value, fps: scope.fps });
	if (ticks === null) {
		throw new ToolError(`${key} isn't a time: seconds, m:ss.s or f<frame>`);
	}
	return ticks;
}

function optionalTime({
	scope,
	value,
	key,
}: {
	scope: Scope;
	value: unknown;
	key: string;
}): number | undefined {
	return value === undefined ? undefined : time({ scope, value, key });
}

/** The element a short id names, and its track. */
function element({ scope, id }: { scope: Scope; id: unknown }): {
	track: TimelineTrack;
	element: TimelineElement;
} {
	if (typeof id !== "string") throw new ToolError("an element's id is needed");
	const tracks = tracksOf({ editor: scope.editor });
	const full = resolveId({
		short: id,
		ids: allIds({ tracks, assets: [] }),
	});
	for (const { track } of namedTracks({ tracks })) {
		const found = track.elements.find((candidate) => candidate.id === full);
		if (found) return { track, element: found };
	}
	throw new ToolError(`${id} isn't on the timeline: see summary`);
}

/** The track a name (V1, T2, A1…) names. */
function trackNamed({
	scope,
	name,
}: {
	scope: Scope;
	name: unknown;
}): TimelineTrack {
	const tracks = tracksOf({ editor: scope.editor });
	const found = namedTracks({ tracks }).find(
		(candidate) =>
			typeof name === "string" && candidate.name === name.toUpperCase(),
	);
	if (!found) throw new ToolError(`There's no track ${String(name)}`);
	return found.track;
}

function trackEnd({ track }: { track: TimelineTrack }): number {
	return Math.max(
		0,
		...track.elements.map((one) => one.startTime + one.duration),
	);
}

const OPERATIONS: Record<
	string,
	(args: { scope: Scope; operation: Operation }) => void
> = {
	insert: ({ scope, operation }) => {
		const { editor } = scope;
		const assets = editor.media.getAssets();
		const id =
			typeof operation.media === "string"
				? resolveId({
						short: operation.media,
						ids: assets.map((asset) => asset.id),
					})
				: null;
		const asset = assets.find((candidate) => candidate.id === id);
		if (!asset) throw new ToolError("media names a medium: see summary");
		const track =
			operation.track === undefined
				? null
				: trackNamed({ scope, name: operation.track });
		const main = tracksOf({ editor }).main;
		const visual = asset.type !== "audio";
		const at =
			optionalTime({ scope, value: operation.at, key: "at" }) ??
			(track
				? trackEnd({ track })
				: visual
					? trackEnd({ track: main })
					: editor.timeline.getTotalDuration());
		editor.timeline.insertElement({
			element: buildElementFromMedia({
				mediaId: asset.id,
				mediaType: asset.type,
				name: asset.name,
				duration:
					asset.duration != null
						? mediaTimeFromSeconds({ seconds: asset.duration })
						: DEFAULT_NEW_ELEMENT_DURATION,
				startTime: mediaTime({ ticks: at }),
			}),
			placement: track
				? { mode: "explicit", trackId: track.id }
				: visual && operation.at === undefined
					? { mode: "explicit", trackId: main.id }
					: { mode: "auto" },
		});
	},
	text: ({ scope, operation }) => {
		if (typeof operation.text !== "string" || !operation.text.trim()) {
			throw new ToolError("text needs its words");
		}
		const at = time({ scope, value: operation.at, key: "at" });
		const to = optionalTime({ scope, value: operation.to, key: "to" });
		if (to !== undefined && to <= at) throw new ToolError("to is after at");
		const track =
			operation.track === undefined
				? null
				: trackNamed({ scope, name: operation.track });
		scope.editor.timeline.insertElement({
			element: buildTextElement({
				raw: {
					name: operation.text.slice(0, 30),
					duration: mediaTime({
						ticks: to === undefined ? DEFAULT_NEW_ELEMENT_DURATION : to - at,
					}),
					params: { content: operation.text },
				},
				startTime: mediaTime({ ticks: at }),
			}),
			placement: track
				? { mode: "explicit", trackId: track.id }
				: { mode: "auto", trackType: "text" },
		});
	},
	cut: ({ scope, operation }) => {
		const at = time({ scope, value: operation.at, key: "at" });
		const tracks = tracksOf({ editor: scope.editor });
		const refs = Array.isArray(operation.ids)
			? operation.ids.map((id) => {
					const found = element({ scope, id });
					return { trackId: found.track.id, elementId: found.element.id };
				})
			: namedTracks({ tracks }).flatMap(({ track }) =>
					track.elements
						.filter(
							(one) => one.startTime < at && at < one.startTime + one.duration,
						)
						.map((one) => ({ trackId: track.id, elementId: one.id })),
				);
		if (refs.length === 0) throw new ToolError("nothing to cut there");
		scope.editor.timeline.splitElements({
			elements: refs,
			splitTime: mediaTime({ ticks: at }),
		});
	},
	trim: ({ scope, operation }) => {
		const { element: clip } = element({ scope, id: operation.id });
		const start =
			optionalTime({ scope, value: operation.start, key: "start" }) ??
			clip.startTime;
		const end =
			optionalTime({ scope, value: operation.end, key: "end" }) ??
			clip.startTime + clip.duration;
		if (end <= start) throw new ToolError("end is after start");
		const rate =
			(clip.type === "video" || clip.type === "audio") && clip.retime
				? clip.retime.rate
				: 1;
		const hasSource = clip.type === "video" || clip.type === "audio";
		const trimStart = hasSource
			? clip.trimStart + (start - clip.startTime) * rate
			: 0;
		const trimEnd = hasSource
			? clip.trimEnd + (clip.startTime + clip.duration - end) * rate
			: 0;
		if (trimStart < 0 || trimEnd < 0) {
			throw new ToolError(
				"that's past the media's own start or end: the clip can't be that long",
			);
		}
		scope.editor.timeline.updateElementTrim({
			elementId: clip.id,
			trimStart: mediaTime({ ticks: Math.round(trimStart) }),
			trimEnd: mediaTime({ ticks: Math.round(trimEnd) }),
			startTime: mediaTime({ ticks: start }),
			duration: mediaTime({ ticks: end - start }),
		});
	},
	move: ({ scope, operation }) => {
		const found = element({ scope, id: operation.id });
		const to = time({ scope, value: operation.to, key: "to" });
		const target =
			operation.track === undefined
				? found.track
				: trackNamed({ scope, name: operation.track });
		if (target.type !== found.track.type) {
			throw new ToolError(
				`a ${found.track.type} clip goes on a ${found.track.type} track`,
			);
		}
		scope.editor.timeline.moveElements({
			moves: [
				{
					sourceTrackId: found.track.id,
					targetTrackId: target.id,
					elementId: found.element.id,
					newStartTime: mediaTime({ ticks: to }),
				},
			],
		});
	},
	delete: ({ scope, operation }) => {
		const ids = Array.isArray(operation.ids)
			? operation.ids
			: operation.id !== undefined
				? [operation.id]
				: [];
		if (ids.length === 0) throw new ToolError("delete needs ids");
		const refs = ids.map((id) => {
			const found = element({ scope, id });
			return { trackId: found.track.id, elementId: found.element.id };
		});
		const { command } = scope.editor;
		const ripple = command.isRippleEnabled;
		command.setRippleEnabled({ enabled: operation.close === true });
		try {
			scope.editor.timeline.deleteElements({ elements: refs });
		} finally {
			command.setRippleEnabled({ enabled: ripple });
		}
	},
	transition: ({ scope, operation }) => {
		const found = element({ scope, id: operation.from });
		if (found.track.type !== "video") {
			throw new ToolError(
				"a transition goes between two clips of a video track",
			);
		}
		const end = found.element.startTime + found.element.duration;
		const next = found.track.elements.find(
			(candidate) => candidate.startTime === end,
		);
		if (!next) {
			throw new ToolError(
				`no clip starts where ${String(operation.from)} ends: move one there first`,
			);
		}
		const duration = optionalTime({
			scope,
			value: operation.duration,
			key: "duration",
		});
		scope.editor.timeline.addTransition({
			trackId: found.track.id,
			fromElementId: found.element.id,
			toElementId: next.id,
			type:
				typeof operation.type === "string"
					? operation.type
					: DEFAULT_TRANSITION_TYPE,
			duration:
				duration === undefined ? undefined : mediaTime({ ticks: duration }),
		});
	},
};

export const editTool: Tool = {
	name: "edit",
	description: [
		"Change the open project: operations done in order, as one step of undo; dryRun shows what would change. Answers with what changed. Ids and track names as in summary; times in seconds, m:ss.s or f<frame>.",
		"insert {media, at?, track?}: a medium as a clip (at the end of V1 by default)",
		"text {text, at, to?, track?}: words on the picture",
		"cut {at, ids?}: split the clips under at (those named, or all)",
		"trim {id, start?, end?}: where a clip starts and ends on the timeline",
		"move {id, to, track?}",
		"delete {ids, close?}: close leaves no gap",
		"transition {from, type?, duration?}: into the clip that starts where from ends (type cross-dissolve by default)",
	].join("\n"),
	inputSchema: {
		type: "object",
		properties: {
			operations: {
				type: "array",
				items: {
					type: "object",
					properties: { op: { type: "string", enum: Object.keys(OPERATIONS) } },
					required: ["op"],
				},
			},
			dryRun: { type: "boolean" },
			rev: {
				type: "string",
				description:
					"The rev the operations were planned on, from summary: refused if it's changed since",
			},
		},
		required: ["operations"],
	},
	run: async ({ args, context: { editor } }) => {
		const project = editor.project.getActiveOrNull();
		if (!project || location.pathname !== "/editor") {
			throw new ToolError("No project is open: `project` first");
		}
		const operations = Array.isArray(args.operations)
			? args.operations.filter(
					(one): one is Operation => typeof one === "object" && one !== null,
				)
			: [];
		if (operations.length === 0) throw new ToolError("no operations");
		const before = tracksOf({ editor });
		const revision = revisionOf({ value: before });
		if (typeof args.rev === "string" && args.rev !== revision) {
			throw new ToolError(
				`The project changed since rev ${args.rev} (now ${revision}): read the summary again`,
			);
		}
		const scope: Scope = {
			editor,
			fps: frameRateToFloat(project.settings.fps),
		};
		const mark = editor.command.getHistoryLength();
		const putBack = () => {
			editor.timeline.updateTracks(before);
			editor.command.dropSince({ length: mark });
		};
		for (const [index, operation] of operations.entries()) {
			const apply = OPERATIONS[String(operation.op)];
			try {
				if (!apply) {
					throw new ToolError(
						`no operation ${String(operation.op)}: ${Object.keys(OPERATIONS).join(", ")}`,
					);
				}
				apply({ scope, operation });
			} catch (error) {
				putBack();
				const message = error instanceof Error ? error.message : String(error);
				throw new ToolError(
					`operation ${index + 1} (${String(operation.op)}): ${message}. Nothing was changed.`,
				);
			}
		}
		const after = tracksOf({ editor });
		const changes = diffTracks({
			before,
			after,
			assets: editor.media.getAssets(),
		});
		if (args.dryRun === true) {
			putBack();
			return {
				content: [{ type: "text", text: `would change:\n${changes}` }],
			};
		}
		editor.command.foldSince({
			length: mark,
			command: new TracksSnapshotCommand({ before, after }),
		});
		return {
			content: [
				{
					type: "text",
					text: `${changes}\nrev ${revisionOf({ value: after })}`,
				},
			],
		};
	},
};

export const undoTool: Tool = {
	name: "undo",
	description:
		"Undo or redo the last step (an edit batch is one), as the user's Undo does.",
	inputSchema: {
		type: "object",
		properties: { redo: { type: "boolean" } },
	},
	run: async ({ args, context: { editor } }) => {
		const before = tracksOf({ editor });
		if (args.redo === true) {
			if (!editor.command.canRedo()) throw new ToolError("nothing to redo");
			editor.command.redo();
		} else {
			if (!editor.command.canUndo()) throw new ToolError("nothing to undo");
			editor.command.undo();
		}
		const after = tracksOf({ editor });
		return {
			content: [
				{
					type: "text",
					text: `${diffTracks({ before, after, assets: editor.media.getAssets() })}\nrev ${revisionOf({ value: after })}`,
				},
			],
		};
	},
};
