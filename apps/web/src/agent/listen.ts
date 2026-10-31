import { findHideRegions } from "@/hide/find";
import { trackHideRegion } from "@/hide/track";
import {
	DETECTOR_SIZES,
	isDetectorDownloaded,
	type DetectorKind,
} from "@/hide/models";
import { HIDE_LOOKS } from "@/hide/region";
import { frameRateToFloat } from "@/fps/utils";
import { decodeAudioToFloat32 } from "@/media/audio";
import { createTimelineAudioBuffer } from "@/media/audio-mix";
import { extractTimelineAudio } from "@/media/mediabunny";
import { transcriptionService } from "@/services/transcription/service";
import { DEFAULT_TRANSCRIPTION_SAMPLE_RATE } from "@/transcription/audio";
import {
	DEFAULT_TRANSCRIPTION_MODEL,
	TRANSCRIPTION_MODELS,
} from "@/transcription/models";
import { mediaTime, TICKS_PER_SECOND } from "@/wasm";
import { resolveId } from "./ids";
import { findShots } from "./shots";
import { askUser, isCached } from "./consent";
import {
	findSilences,
	integratedLoudness,
	samplePeak,
	type Stretch,
} from "./sound";
import { formatTime, parseTime } from "./time";
import { ToolError, type Tool, type ToolContext } from "./tools-base";

// Hearing and finding, for an agent (docs/AUTOMATION.md): the timeline's
// words, silences and loudness as text it can cut by, and the faces, plates
// and black bars in its picture. A model that isn't downloaded yet is asked
// for in the window, never fetched on the agent's say-so.

// The rate the timeline's sound is measured at.
const SOUND_RATE = 48_000;

function needOpen({ editor }: { editor: ToolContext["editor"] }) {
	const project = editor.project.getActiveOrNull();
	if (!project || location.pathname !== "/editor") {
		throw new ToolError("No project is open: `project` first");
	}
	return project;
}

/** The span asked for, in seconds: the whole timeline by default. */
function span({
	args,
	editor,
}: {
	args: Record<string, unknown>;
	editor: ToolContext["editor"];
}): Stretch {
	const project = needOpen({ editor });
	const fps = frameRateToFloat(project.settings.fps);
	const end = editor.timeline.getTotalDuration();
	const from =
		args.from === undefined ? 0 : parseTime({ value: args.from, fps });
	const to = args.to === undefined ? end : parseTime({ value: args.to, fps });
	if (from === null || to === null || to <= from) {
		throw new ToolError("from and to are times, from before to");
	}
	return {
		from: from / TICKS_PER_SECOND,
		to: Math.min(to, end) / TICKS_PER_SECOND,
	};
}

const seconds = (value: number) => value.toFixed(2);

async function soundOf({
	editor,
	stretch,
}: {
	editor: ToolContext["editor"];
	stretch: Stretch;
}): Promise<Float32Array[]> {
	const buffer = await createTimelineAudioBuffer({
		tracks: editor.scenes.getActiveScene().tracks,
		mediaAssets: editor.media.getAssets(),
		duration: editor.timeline.getTotalDuration(),
		sampleRate: SOUND_RATE,
	});
	if (!buffer) throw new ToolError("The timeline has no sound");
	const first = Math.floor(stretch.from * SOUND_RATE);
	const last = Math.min(buffer.length, Math.ceil(stretch.to * SOUND_RATE));
	return Array.from({ length: buffer.numberOfChannels }, (_, channel) =>
		buffer.getChannelData(channel).slice(first, last),
	);
}

async function transcribe({
	context,
	stretch,
	words,
}: {
	context: ToolContext;
	stretch: Stretch;
	words: boolean;
}) {
	const { editor, agent, progress } = context;
	const model = TRANSCRIPTION_MODELS.find(
		(candidate) => candidate.id === DEFAULT_TRANSCRIPTION_MODEL,
	);
	if (!model) throw new ToolError("No transcription model");
	const downloaded = await isCached({
		name: "transformers-cache",
		part: model.huggingFaceId,
	});
	if (
		!downloaded &&
		!(await askUser({
			title: `${agent} wants to transcribe`,
			description: `That downloads Whisper ${model.name} once from Hugging Face; then it transcribes on this computer.`,
			allow: "Download",
		}))
	) {
		throw new ToolError(
			`The user didn't allow downloading Whisper ${model.name}; they can transcribe in the Captions panel instead`,
		);
	}
	const audioBlob = await extractTimelineAudio({
		tracks: editor.scenes.getActiveScene().tracks,
		mediaAssets: editor.media.getAssets(),
		totalDuration: editor.timeline.getTotalDuration(),
	});
	const { samples } = await decodeAudioToFloat32({
		audioBlob,
		sampleRate: DEFAULT_TRANSCRIPTION_SAMPLE_RATE,
	});
	const part = samples.slice(
		Math.floor(stretch.from * DEFAULT_TRANSCRIPTION_SAMPLE_RATE),
		Math.ceil(stretch.to * DEFAULT_TRANSCRIPTION_SAMPLE_RATE),
	);
	const result = await transcriptionService.transcribe({
		audioData: part,
		words,
		onProgress: ({ progress: done }) =>
			progress({ progress: Math.round(done ?? 0), total: 100 }),
	});
	const shift = (segment: { start: number; end: number }) => ({
		start: segment.start + stretch.from,
		end: segment.end + stretch.from,
	});
	return {
		segments: result.segments.map((segment) => ({
			...segment,
			...shift(segment),
		})),
		words: result.words?.map((word) => ({ ...word, ...shift(word) })),
	};
}

export const listenTool: Tool = {
	name: "listen",
	description:
		"Hear the timeline, over from-to or all of it: transcript (lines with times), words (numbered, each with its start-end in seconds, to cut by), silences (start-end in seconds), or loudness (integrated LUFS and peak). Transcribing runs Whisper on this computer.",
	inputSchema: {
		type: "object",
		properties: {
			what: {
				type: "string",
				enum: ["transcript", "words", "silences", "loudness"],
			},
			from: { type: ["string", "number"] },
			to: { type: ["string", "number"] },
			minSilence: {
				type: "number",
				description: "Seconds: silences at least this long (0.5)",
			},
			threshold: {
				type: "number",
				description: "dBFS under which it's silence (-45)",
			},
		},
		required: ["what"],
	},
	run: async ({ args, context }) => {
		const { editor } = context;
		const stretch = span({ args, editor });
		switch (args.what) {
			case "silences": {
				const silences = findSilences({
					channels: await soundOf({ editor, stretch }),
					sampleRate: SOUND_RATE,
					thresholdDb:
						typeof args.threshold === "number" ? args.threshold : -45,
					minSeconds:
						typeof args.minSilence === "number" ? args.minSilence : 0.5,
				}).map((silence) => ({
					from: silence.from + stretch.from,
					to: silence.to + stretch.from,
				}));
				const total = silences.reduce((sum, one) => sum + one.to - one.from, 0);
				return {
					content: [
						{
							type: "text",
							text:
								silences.length === 0
									? "no silences that long"
									: `${silences.length} silences, ${seconds(total)} s in all:\n${silences
											.map((one) => `${seconds(one.from)}-${seconds(one.to)}`)
											.join(" ")}`,
						},
					],
				};
			}
			case "loudness": {
				const channels = await soundOf({ editor, stretch });
				const loudness = integratedLoudness({
					channels,
					sampleRate: SOUND_RATE,
				});
				const peak = samplePeak({ channels });
				return {
					content: [
						{
							type: "text",
							text:
								loudness === null
									? "silent"
									: `integrated ${loudness.toFixed(1)} LUFS, peak ${peak?.toFixed(1)} dBFS (sample peak)`,
						},
					],
				};
			}
			case "transcript":
			case "words": {
				const words = args.what === "words";
				const heard = await transcribe({ context, stretch, words });
				const text = words
					? (heard.words ?? [])
							.map(
								(word, index) =>
									`${index + 1} ${seconds(word.start)}-${seconds(word.end)} ${word.text.trim()}`,
							)
							.join("\n")
					: heard.segments
							.map(
								(segment) =>
									`${formatTime({ ticks: segment.start * TICKS_PER_SECOND })}-${formatTime({ ticks: segment.end * TICKS_PER_SECOND })} ${segment.text.trim()}`,
							)
							.join("\n");
				return {
					content: [{ type: "text", text: text || "nothing heard" }],
				};
			}
			default:
				throw new ToolError("what is transcript, words, silences or loudness");
		}
	},
};

export const findTool: Tool = {
	name: "find",
	description:
		"Find in the picture: faces or plates (each found one a Hide region that follows it, blurred, pixelated or covered; over the selected clip, or the whole timeline), shots (where the picture cuts, over from-to), black bars (to crop on export), or track: a Hide region (id) followed through its frames from at.",
	inputSchema: {
		type: "object",
		properties: {
			what: {
				type: "string",
				enum: ["faces", "plates", "shots", "blackbars", "track"],
			},
			look: { type: "string", enum: HIDE_LOOKS.map((look) => look.effectType) },
			id: { type: "string", description: "For track: the Hide region" },
			at: {
				type: ["string", "number"],
				description:
					"For track: the frame it's right on (its start by default)",
			},
			from: { type: ["string", "number"] },
			to: { type: ["string", "number"] },
		},
		required: ["what"],
	},
	run: async ({ args, context }) => {
		const { editor, agent, progress, isStopped } = context;
		needOpen({ editor });
		if (args.what === "blackbars") {
			const crop = await editor.renderer.detectBlackBars();
			const project = editor.project.getActive();
			const { width, height } = project.settings.canvasSize;
			return {
				content: [
					{
						type: "text",
						text:
							!crop || crop.top + crop.bottom + crop.left + crop.right === 0
								? "no black bars"
								: `black bars, in pixels of ${width}x${height}: top ${crop.top}, bottom ${crop.bottom}, left ${crop.left}, right ${crop.right}`,
					},
				],
			};
		}
		if (args.what === "shots") {
			const stretch = span({ args, editor });
			const cuts = await findShots({
				editor,
				from: Math.round(stretch.from * TICKS_PER_SECOND),
				to: Math.round(stretch.to * TICKS_PER_SECOND),
				onProgress: (done) =>
					progress({ progress: Math.round(done * 100), total: 100 }),
				isCancelled: isStopped,
			});
			return {
				content: [
					{
						type: "text",
						text:
							cuts.length === 0
								? "one shot: no cuts"
								: `${cuts.length} cuts, at ${cuts.map((cut) => seconds(cut / TICKS_PER_SECOND)).join(" ")}`,
					},
				],
			};
		}
		if (args.what === "track") {
			const tracks = editor.scenes.getActiveScene().tracks;
			const wanted = typeof args.id === "string" ? args.id : "";
			const ids = tracks.overlay.flatMap((track) =>
				track.elements.map((element) => element.id),
			);
			const full = resolveId({ short: wanted, ids });
			const track = tracks.overlay.find((candidate) =>
				candidate.elements.some((element) => element.id === full),
			);
			const region = track?.elements.find((element) => element.id === full);
			if (
				!track ||
				!region ||
				region.type !== "effect" ||
				!region.masks?.length
			) {
				throw new ToolError(`${wanted} isn't a Hide region: see summary`);
			}
			const project = editor.project.getActive();
			const at =
				args.at === undefined
					? region.startTime
					: parseTime({
							value: args.at,
							fps: frameRateToFloat(project.settings.fps),
						});
			if (at === null) throw new ToolError("at isn't a time");
			editor.playback.seek({ time: mediaTime({ ticks: at }) });
			const result = await trackHideRegion({
				editor,
				trackId: track.id,
				elementId: region.id,
				onProgress: ({ progress: done }) =>
					progress({ progress: Math.round(done * 100), total: 100 }),
				isCancelled: isStopped,
			});
			if (!result) throw new ToolError("It couldn't be tracked");
			const lost = [
				result.lostForward !== null
					? `lost going forward at ${formatTime({ ticks: result.lostForward })}`
					: "",
				result.lostBack !== null
					? `lost going back at ${formatTime({ ticks: result.lostBack })}`
					: "",
			].filter(Boolean);
			return {
				content: [
					{
						type: "text",
						text: `tracked, ${result.frames} frames keyframed${lost.length ? `; ${lost.join(", ")}` : ", to its ends"}`,
					},
				],
			};
		}
		if (args.what !== "faces" && args.what !== "plates") {
			throw new ToolError("what is faces, plates, shots, blackbars or track");
		}
		const kind: DetectorKind = args.what;
		if (
			!(await isDetectorDownloaded({ kind })) &&
			!(await askUser({
				title: `${agent} wants to find ${kind}`,
				description: `That downloads a ${kind === "faces" ? "face" : "plate"} detector (${DETECTOR_SIZES[kind]}) once from Hugging Face; then it runs on this computer.`,
				allow: "Download",
			}))
		) {
			throw new ToolError(
				`The user didn't allow downloading the ${kind} detector`,
			);
		}
		const look =
			HIDE_LOOKS.find((candidate) => candidate.effectType === args.look) ??
			HIDE_LOOKS[kind === "faces" ? 0 : 2];
		const { added } = await findHideRegions({
			editor,
			kind,
			look,
			onProgress: ({ progress: done }) =>
				progress({ progress: Math.round(done * 100), total: 100 }),
			isCancelled: isStopped,
		});
		return {
			content: [
				{
					type: "text",
					text:
						added === 0
							? `no ${kind} found`
							: `${added} ${kind === "faces" ? "face" : "plate"}${added === 1 ? "" : "s"} hidden, each a Hide region (see summary); the user should check each one`,
				},
			],
		};
	},
};
