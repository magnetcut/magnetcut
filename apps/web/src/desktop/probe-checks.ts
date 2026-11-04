import { invoke } from "@tauri-apps/api/core";
import {
	ALL_FORMATS,
	CanvasSource,
	canEncodeVideo,
	Input,
	Output,
	StreamTarget,
	VideoSampleSink,
	type VideoCodec,
} from "mediabunny";
import { findShots } from "@/agent/shots";
import { UpdateElementsCommand } from "@/commands";
import { EditorCore } from "@/core";
import { adoptSavedFile, openFolderFile } from "@/export/disk-target";
import {
	CONFORM_CODECS,
	planConform,
	readFileTraits,
	type ConformFile,
} from "@/export/fast/conform";
import { chooseColourInput, convertFile } from "@/export/fast/convert";
import { exportFast } from "@/export/fast/exporter";
import { createOutputFormat } from "@/export/output-format";
import {
	createMediaSource,
	DiskFile,
	type DiskFileInfo,
	type MediaFile,
} from "@/media/disk-file";
import { checkEncoderColour, readStreamColour } from "@/media/encoder-colour";
import { processMediaAssets } from "@/media/processing";
import { makeProxy } from "@/media/proxy";
import type { MediaAsset } from "@/media/types";
import { initializeGpuRenderer } from "@/services/renderer/gpu-renderer";
import { FILE_CHUNK_SIZE } from "@/services/renderer/scene-exporter";
import {
	addTranslationTrack,
	insertCaptionChunksAsTextTrack,
} from "@/subtitles/insert";
import {
	getLineUpdates,
	getSubtitleLines,
	getSubtitleTracks,
} from "@/subtitles/track";
import type { SceneTracks, TextTrack, VideoElement } from "@/timeline";
import { buildElementFromMedia } from "@/timeline/element-utils";
import { findLanes } from "@/voiceover/place";
import { VoiceRecorder } from "@/voiceover/recorder";
import {
	listCuesToSpeak,
	speakCues,
	speechApi,
	spokenTrackName,
	type SpeechChoice,
} from "@/voiceover/speech";
import {
	mediaTime,
	mediaTimeFromSeconds,
	mediaTimeToSeconds,
	TICKS_PER_SECOND,
} from "@/wasm";

/*
 * The web view probe's checks of the editor's own code (apps/desktop/src/
 * probe.js, which calls them in each system's web view): a take recorded from
 * a stand-in microphone and from the real one, the system's voices, a
 * translation dubbed, the cut between two pictures found, clips converted to
 * match and joined by Fast mode, and a proxy made, each written where the
 * desktop app writes them. Never run outside the probe.
 */

export interface ProbeOptions {
	/** Record from the microphone too: the system may ask first. */
	microphone: boolean;
	/**
	 * Speak a sentence with ElevenLabs and OpenAI too, with the keys in the
	 * keychain: sent to them, and counted against the account.
	 */
	providers?: boolean;
}

export async function runProbeChecks({
	microphone,
	providers = false,
}: ProbeOptions): Promise<Record<string, unknown>> {
	const folder = await invoke<string>("probe_folder");
	return {
		recorder: await attempt({
			check: () => recordFromTone({ folder }),
			seconds: 20,
		}),
		microphone: microphone
			? await attempt({ check: () => recordSecond({ folder }), seconds: 20 })
			: "not asked",
		systemVoices: await attempt({ check: checkSystemVoices, seconds: 30 }),
		providers: providers
			? await attempt({ check: checkProviders, seconds: 90 })
			: "not asked",
		dubbing: await attempt({
			check: () => checkDubbing({ folder }),
			seconds: 90,
		}),
		shots: await attempt({ check: () => checkShots({ folder }), seconds: 120 }),
		conform: await attempt({
			check: () => checkConform({ folder }),
			seconds: 90,
		}),
		proxy: await attempt({ check: () => checkProxy({ folder }), seconds: 90 }),
	};
}

/** A check's result, or what went wrong: within `seconds`, so the report is made. */
async function attempt({
	check,
	seconds,
}: {
	check: () => Promise<unknown>;
	seconds: number;
}): Promise<unknown> {
	try {
		return await withTimeout({ promise: check(), seconds });
	} catch (error) {
		return `error: ${error instanceof Error ? error.message : String(error)}`;
	}
}

function withTimeout<T>({
	promise,
	seconds,
}: {
	promise: Promise<T>;
	seconds: number;
}): Promise<T> {
	return Promise.race([
		promise,
		new Promise<never>((_, reject) =>
			setTimeout(
				() => reject(new Error(`no answer in ${seconds} s`)),
				seconds * 1000,
			),
		),
	]);
}

const wait = ({ ms }: { ms: number }) =>
	new Promise((resolve) => setTimeout(resolve, ms));

/** A WAV file's length and loudest sample, read from its chunks. */
function readWav({ bytes }: { bytes: Uint8Array }): {
	seconds: number;
	sampleRate: number;
	channels: number;
	peak: number;
} {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const tag = (at: number) =>
		String.fromCharCode(...bytes.subarray(at, at + 4));
	if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a WAV");
	let channels = 0;
	let sampleRate = 0;
	let bits = 0;
	for (let at = 12; at + 8 <= bytes.length; ) {
		const size = view.getUint32(at + 4, true);
		if (tag(at) === "fmt ") {
			channels = view.getUint16(at + 10, true);
			sampleRate = view.getUint32(at + 12, true);
			bits = view.getUint16(at + 22, true);
		}
		if (tag(at) === "data") {
			if (bits !== 16) throw new Error(`${bits}-bit samples`);
			const end = Math.min(bytes.length, at + 8 + size);
			let peak = 0;
			for (let sample = at + 8; sample + 1 < end; sample += 2) {
				peak = Math.max(peak, Math.abs(view.getInt16(sample, true)));
			}
			const frames = (end - at - 8) / (2 * channels);
			return {
				seconds: Math.round((frames / sampleRate) * 1000) / 1000,
				sampleRate,
				channels,
				peak: Math.round((peak / 32768) * 1000) / 1000,
			};
		}
		at += 8 + size + (size % 2);
	}
	throw new Error("no samples");
}

/** A second recorded by the voice-over's recorder, into the folder. */
async function recordSecond({ folder }: { folder: string }) {
	const recorder = await VoiceRecorder.open({ processing: false });
	try {
		await recorder.start({ folder, name: "probe take.wav" });
		await wait({ ms: 1000 });
		const take = await recorder.stop();
		const bytes = new Uint8Array(await take.arrayBuffer());
		return {
			onDisk: take instanceof DiskFile,
			...readWav({ bytes }),
		};
	} finally {
		await recorder.close();
	}
}

/** The same with a 440 Hz tone given as the microphone: the worklet's part. */
async function recordFromTone({ folder }: { folder: string }) {
	const devices = navigator.mediaDevices;
	if (!devices) return "no navigator.mediaDevices";
	const tone = new AudioContext();
	const oscillator = tone.createOscillator();
	oscillator.frequency.value = 440;
	const gain = tone.createGain();
	gain.gain.value = 0.5;
	const destination = tone.createMediaStreamDestination();
	oscillator.connect(gain).connect(destination);
	oscillator.start();
	await tone.resume();
	devices.getUserMedia = () => Promise.resolve(destination.stream);
	try {
		return { toneContext: tone.state, ...(await recordSecond({ folder })) };
	} finally {
		// The stand-in was the object's own: the prototype's is back.
		Reflect.deleteProperty(devices, "getUserMedia");
		oscillator.stop();
		await tone.close();
	}
}

interface SystemVoice {
	id: string;
	name: string;
	language: string | null;
}

/** The voices on this computer, and a sentence spoken by the default one. */
async function checkSystemVoices() {
	const voices = await invoke<SystemVoice[]>("speech_voices", {
		provider: "system",
	});
	const spoken = await invoke<ArrayBuffer>("speak", {
		provider: "system",
		text: "MagnetCut speaks the subtitles.",
		voice: "",
		model: null,
		instructions: null,
	});
	return {
		voices: voices.length,
		first: voices
			.slice(0, 3)
			.map(({ name, language }) => `${name} (${language})`),
		spoken: readWav({ bytes: new Uint8Array(spoken) }),
	};
}

/**
 * ElevenLabs and OpenAI, each with the key in the keychain (the web view never
 * holds it): its voices and models, ElevenLabs' characters this month, and a
 * short sentence spoken by its first voice, with its default model.
 */
async function checkProviders() {
	const keys = await speechApi.keys();
	const results: Record<string, unknown> = {};
	for (const provider of ["elevenlabs", "openai"] as const) {
		if (!keys[provider]) {
			results[provider] = "no key";
			continue;
		}
		results[provider] = await attempt({
			check: async () => {
				const voices = await speechApi.voices({ provider });
				const models = await speechApi.models({ provider });
				const quota = await speechApi.quota({ provider });
				const [voice] = voices;
				if (!voice) throw new Error("no voices");
				const spoken = await invoke<ArrayBuffer>("speak", {
					provider,
					text: "MagnetCut speaks the subtitles.",
					voice: voice.id,
					model: null,
					instructions: null,
				});
				return {
					voices: voices.length,
					voice: voice.name,
					models: models.map(({ id }) => id),
					quota,
					spoken: readWav({ bytes: new Uint8Array(spoken) }),
				};
			},
			seconds: 40,
		});
	}
	return results;
}

// The subtitles dubbed: English, and the first of these a voice speaks.
const ORIGINAL_LINES = ["Good morning, everyone.", "See you tomorrow."];
const DUBBED_LINES: [string, string[]][] = [
	["it", ["Buongiorno a tutti.", "Ci vediamo domani."]],
	["fr", ["Bonjour à tous.", "À demain."]],
	["de", ["Guten Morgen allerseits.", "Bis morgen."]],
	["es", ["Buenos días a todos.", "Hasta mañana."]],
];
// Seconds: each line's start and length.
const LINE_TIMES = [
	{ startTime: 0.5, duration: 2.5 },
	{ startTime: 3.5, duration: 2.5 },
];

/**
 * A translation dubbed (docs/VOICEOVER.md), with the panels' own code: a
 * project with English subtitles, Captions' Translate, its lines written
 * over in a language one of the system's voices speaks (English where none
 * other is there, as on GitHub's Windows), the original and the translation
 * spoken, and their clips looked for on their own tracks at the lines'
 * starts. Spoken again, the translation comes from the project. The project
 * is deleted after.
 */
async function checkDubbing({ folder }: { folder: string }) {
	const editor = EditorCore.getInstance();
	if (editor.project.getActiveOrNull()) throw new Error("a project is open");
	const voices = await invoke<SystemVoice[]>("speech_voices", {
		provider: "system",
	});
	const [dub] = DUBBED_LINES.flatMap(([language, lines]) => {
		const voice = voices.find((each) =>
			each.language?.toLowerCase().startsWith(language),
		);
		return voice ? [{ voice, lines }] : [];
	});
	const voice = dub?.voice ?? voices[0];
	if (!voice) throw new Error("no voices");
	const lines = dub?.lines ?? ORIGINAL_LINES;

	const id = await editor.project.createNewProject({ name: "Probe: dubbing" });
	try {
		const findTrack = ({ trackId }: { trackId: string | null }): TextTrack => {
			const track = getSubtitleTracks({
				tracks: editor.scenes.getActiveScene().tracks,
			}).find((each) => each.id === trackId);
			if (!track) throw new Error(`no subtitle track ${trackId}`);
			return track;
		};
		const original = findTrack({
			trackId: insertCaptionChunksAsTextTrack({
				editor,
				captions: ORIGINAL_LINES.map((text, index) => ({
					text,
					...LINE_TIMES[index],
				})),
			}),
		});
		const copy = findTrack({
			trackId: addTranslationTrack({ editor, track: original }),
		});
		const copied = getSubtitleLines({ track: copy });
		editor.command.execute({
			command: new UpdateElementsCommand({
				updates: getLineUpdates({
					track: copy,
					lines: copied,
					cues: copied.map(({ cue }, index) => ({
						...cue,
						text: lines[index],
					})),
				}),
			}),
		});
		const translation = findTrack({ trackId: copy.id });

		const speak = ({
			track,
			choice,
		}: {
			track: TextTrack;
			choice: SpeechChoice;
		}) =>
			speakCues({
				editor,
				cues: listCuesToSpeak({
					track,
					choice,
					mediaAssets: editor.media.getAssets(),
				}),
				choice,
				folder,
				trackName: spokenTrackName({ track }),
				signal: new AbortController().signal,
				onProgress: () => {},
			});
		const english: SpeechChoice = {
			provider: "system",
			voice: "",
			model: null,
			instructions: null,
		};
		const dubbed: SpeechChoice = { ...english, voice: voice.id };
		const spoken = await speak({ track: original, choice: english });
		const dubbedFirst = await speak({ track: translation, choice: dubbed });
		const dubbedAgain = await speak({ track: translation, choice: dubbed });

		// Each track's clips: where they start, and the words they're named by.
		const clipsOf = ({ track }: { track: TextTrack }) =>
			findLanes({
				tracks: editor.scenes.getActiveScene().tracks,
				name: spokenTrackName({ track }),
			})
				.flatMap(({ elements }) => elements)
				.map(({ startTime, name }) => ({
					start: mediaTimeToSeconds({ time: startTime }),
					name,
				}))
				.sort((a, b) => a.start - b.start);
		const isAtLines = ({ track }: { track: TextTrack }) => {
			const clips = clipsOf({ track });
			const starts = getSubtitleLines({ track }).map(({ cue }) => cue.start);
			return (
				clips.length === starts.length &&
				clips.every(
					({ start }, index) => Math.abs(start - starts[index]) < 0.01,
				)
			);
		};
		return {
			voice: `${voice.name} (${voice.language})`,
			original: {
				track: spokenTrackName({ track: original }),
				spoken: spoken.spoken,
				clips: clipsOf({ track: original }),
			},
			dubbed: {
				track: spokenTrackName({ track: translation }),
				spoken: dubbedFirst.spoken,
				clips: clipsOf({ track: translation }),
				reusedAgain: dubbedAgain.reused,
			},
			atTheirLines:
				isAtLines({ track: original }) && isAtLines({ track: translation }),
			spokenInTranslation: clipsOf({ track: translation }).every(
				({ name }, index) => name.startsWith(lines[index]),
			),
		};
	} finally {
		await editor.save.flush();
		await editor.project.deleteProjects({ ids: [id] });
		editor.command.clear();
	}
}

/** A picture of one grey, as a PNG file in `folder`, adopted as the app adopts files. */
async function writePicture({
	folder,
	name,
	grey,
}: {
	folder: string;
	name: string;
	grey: number;
}): Promise<MediaFile> {
	const canvas = new OffscreenCanvas(64, 36);
	const context = canvas.getContext("2d");
	if (!context) throw new Error("no 2D canvas");
	context.fillStyle = `rgb(${grey}, ${grey}, ${grey})`;
	context.fillRect(0, 0, 64, 36);
	const bytes = new Uint8Array(
		await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer(),
	);
	const { file, path } = await openFolderFile({ folder, name });
	const writer = file.writable.getWriter();
	await writer.write({ type: "write", data: bytes, position: 0 });
	await writer.close();
	return adoptSavedFile({ path });
}

const SHOT_ATTEMPTS = 4;

/**
 * The agent's Find shots (agent/shots.ts) on a dark picture then a light one,
 * as its check on GitHub makes them: each time in a new project, the pictures
 * just brought in. The one cut should be where they meet, at 5 s.
 */
async function checkShots({ folder }: { folder: string }) {
	const editor = EditorCore.getInstance();
	if (editor.project.getActiveOrNull()) throw new Error("a project is open");
	// As the editor's page does before it draws.
	await initializeGpuRenderer();
	const found: string[] = [];
	for (let round = 0; round < SHOT_ATTEMPTS; round++) {
		const id = await editor.project.createNewProject({
			name: `Probe: shots ${round + 1}`,
		});
		try {
			const files = [
				await writePicture({ folder, name: `dark ${round}.png`, grey: 10 }),
				await writePicture({ folder, name: `light ${round}.png`, grey: 240 }),
			];
			for (const asset of await processMediaAssets({ files })) {
				const added = await editor.media.addMediaAsset({
					projectId: id,
					asset,
				});
				if (!added) throw new Error(`${asset.name} wasn't added`);
				editor.timeline.insertElement({
					element: buildElementFromMedia({
						mediaId: added.id,
						mediaType: added.type,
						name: added.name,
						duration: mediaTimeFromSeconds({ seconds: 5 }),
						startTime: mediaTime({
							ticks: editor.timeline.getTotalDuration(),
						}),
					}),
					placement: { mode: "auto" },
				});
			}
			const cuts = await findShots({
				editor,
				from: 0,
				to: editor.timeline.getTotalDuration(),
				onProgress: () => {},
				isCancelled: () => false,
			});
			found.push(
				cuts.map((cut) => (cut / TICKS_PER_SECOND).toFixed(2)).join(" ") ||
					"none",
			);
		} finally {
			await editor.save.flush();
			await editor.project.deleteProjects({ ids: [id] });
			editor.command.clear();
		}
	}
	return {
		cuts: found,
		allAtTheMeeting: found.every((cuts) => cuts === "5.00"),
	};
}

function toAsset({
	id,
	file,
	width,
	height,
	duration,
}: {
	id: string;
	file: MediaFile;
	width: number;
	height: number;
	duration: number;
}): MediaAsset {
	return { id, name: file.name, type: "video", file, width, height, duration };
}

const sizeOf = ({
	traits: { width, height, duration },
}: {
	traits: { width: number; height: number; duration: number };
}) => ({ width, height, duration });

async function findEncodable({
	codecs,
	width,
	height,
}: {
	codecs: readonly VideoCodec[];
	width: number;
	height: number;
}): Promise<VideoCodec | null> {
	for (const codec of codecs) {
		if (await canEncodeVideo(codec, { width, height }).catch(() => false)) {
			return codec;
		}
	}
	return null;
}

const describeColour = ({
	primaries,
	transfer,
	matrix,
	fullRange,
}: VideoColorSpaceInit) =>
	`${primaries ?? "?"} ${transfer ?? "?"} ${matrix ?? "?"} ${fullRange ? "full" : fullRange === false ? "limited" : "?"}`;

/**
 * A film's colour as its container says (what ffmpeg, VLC and QuickTime go
 * by) and as its H.264 stream does (what WebKit goes by): they should agree.
 */
async function readColour({ file }: { file: MediaFile }) {
	const input = new Input({
		source: createMediaSource({ file }),
		formats: ALL_FORMATS,
	});
	try {
		const video = await input.getPrimaryVideoTrack();
		if (!video) throw new Error(`no video in ${file.name}`);
		const container = await video.getColorSpace();
		const config = await video.getDecoderConfig();
		const stream = config ? readStreamColour({ config }) : null;
		return {
			container: describeColour(container),
			stream: stream ? describeColour(stream) : null,
			agree:
				stream === null || (container.fullRange ?? false) === stream.fullRange,
		};
	} finally {
		input.dispose();
	}
}

/** The main track with these films on it, one after the other, whole. */
function buildTracks({ assets }: { assets: MediaAsset[] }): SceneTracks {
	let start = 0;
	const elements = assets.map((asset): VideoElement => {
		const duration = Math.round((asset.duration ?? 0) * TICKS_PER_SECOND);
		const element: VideoElement = {
			id: `clip-${asset.id}`,
			type: "video",
			name: asset.name,
			mediaId: asset.id,
			startTime: mediaTime({ ticks: start }),
			duration: mediaTime({ ticks: duration }),
			trimStart: mediaTime({ ticks: 0 }),
			trimEnd: mediaTime({ ticks: 0 }),
			params: {},
		};
		start += duration;
		return element;
	});
	return {
		overlay: [],
		audio: [],
		main: {
			id: "main",
			name: "Main",
			type: "video",
			muted: false,
			hidden: false,
			elements,
		},
	};
}

/**
 * A film's frames as they're seen, decoded and drawn: Fast mode gives a
 * joined file's parameter sets ids of their own and rewrites its slices to
 * match (export/fast/h264.ts), so it's the pictures that are compared.
 */
async function readFrames({
	file,
}: {
	file: MediaFile;
}): Promise<Uint8ClampedArray[]> {
	const input = new Input({
		source: createMediaSource({ file }),
		formats: ALL_FORMATS,
	});
	try {
		const video = await input.getPrimaryVideoTrack();
		if (!video) throw new Error(`no video in ${file.name}`);
		const [width, height] = [video.displayWidth, video.displayHeight];
		const canvas = new OffscreenCanvas(width, height);
		const context = canvas.getContext("2d");
		if (!context) throw new Error("no 2D canvas");
		const frames: Uint8ClampedArray[] = [];
		try {
			for await (const sample of new VideoSampleSink(video).samples()) {
				sample.draw(context, 0, 0, width, height);
				sample.close();
				frames.push(context.getImageData(0, 0, width, height).data);
			}
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			throw new Error(`${file.name}, after ${frames.length} frames: ${reason}`);
		}
		return frames;
	} finally {
		input.dispose();
	}
}

/** How much two films' pictures differ on average, in each channel of each pixel. */
function findMeanDifference({
	a,
	b,
}: {
	a: Uint8ClampedArray[];
	b: Uint8ClampedArray[];
}): number {
	let sum = 0;
	let count = 0;
	for (let frame = 0; frame < Math.min(a.length, b.length); frame++) {
		const [x, y] = [a[frame], b[frame]];
		for (let index = 0; index < Math.min(x.length, y.length); index += 4) {
			for (let channel = 0; channel < 3; channel++) {
				sum += Math.abs(x[index + channel] - y[index + channel]);
			}
			count += 3;
		}
	}
	return count ? Math.round((sum / count) * 100) / 100 : 255;
}

// A matrix gone wrong moves the camera film's colours by 13 on average;
// resizing and encoding again, by about 3.
const COLOUR_KEPT_WITHIN = 6;

/** The most two pictures differ by in any channel of any pixel. */
function findDifference({
	a,
	b,
}: {
	a: Uint8ClampedArray;
	b: Uint8ClampedArray;
}): number {
	if (a.length !== b.length) return 255;
	let most = 0;
	for (let index = 0; index < a.length; index++) {
		most = Math.max(most, Math.abs(a[index] - b[index]));
	}
	return most;
}

/**
 * docs/CONFORM.md, phase 2: the test films converted to match a camera's sort
 * of film (x264, 320×180), the tiny one with B-frames and the turned one, then
 * joined by Fast mode's No re-encoding, whose frames are the files' own.
 * (Under 192×96, VideoToolbox codes a picture at 192×96 and crops it, and
 * Apple's decoder doesn't take a join of SPSs of different coded sizes:
 * docs/FAST.md.)
 */
async function checkConform({ folder }: { folder: string }) {
	const fixtures = await invoke<DiskFileInfo[]>("probe_fixtures");
	const files: ConformFile[] = [];
	for (const info of fixtures) {
		const file = new DiskFile(info);
		const asset = toAsset({
			id: info.name,
			file,
			width: 0,
			height: 0,
			duration: 0,
		});
		const traits = await readFileTraits({ asset });
		if (!traits) throw new Error(`no video in ${info.name}`);
		files.push({
			...traits,
			asset: { ...asset, ...sizeOf({ traits }) },
			seconds: traits.duration,
			clipCount: 1,
			usedFrom: 0,
			usedTo: traits.duration,
		});
	}
	const codec = await findEncodable({
		codecs: CONFORM_CODECS,
		width: 320,
		height: 180,
	});
	if (!codec) return "no H.264 or VP9 encoder here";
	const target = { codec, width: 320, height: 180 };
	const plan = planConform({ files, target });
	const started = performance.now();
	const used = new Map(files.map(({ asset }) => [asset.id, asset]));
	const colours: Record<string, unknown> = {};
	for (const { file } of plan.files) {
		const converted = await convertFile({
			file,
			target,
			sound: plan.sound,
			colour: plan.colour,
			fit: "contain",
			part: null,
			folder,
		});
		const asset = toAsset({
			id: `${file.asset.id} converted`,
			file: converted,
			width: 0,
			height: 0,
			duration: 0,
		});
		const traits = await readFileTraits({ asset });
		if (!traits) throw new Error(`no video in ${converted.name}`);
		used.set(file.asset.id, { ...asset, ...sizeOf({ traits }) });
		colours[converted.name] = await readColour({ file: converted });
	}
	const converting = (performance.now() - started) / 1000;
	const assets = [...used.values()];

	const format = codec === "vp9" ? "webm" : "mp4";
	const { file, path } = await openFolderFile({
		folder,
		name: `fast.${format}`,
	});
	const output = await exportFast({
		tracks: buildTracks({ assets }),
		mediaAssets: assets,
		mode: "copy",
		format,
		audio: null,
		file,
		isCancelled: () => false,
	});
	if (!output) throw new Error("the Fast export stopped");
	const exported = await adoptSavedFile({ path });
	const expected: Uint8ClampedArray[] = [];
	for (const asset of assets) {
		expected.push(...(await readFrames({ file: asset.file })));
	}
	const copied = await readFrames({ file: exported });
	// The camera's film, which joins as it is, converted anyway: its colours
	// should come out as they went in, whichever way the samples are written.
	const [camera] = files;
	const recoded = await convertFile({
		file: camera,
		target,
		sound: null,
		colour: plan.colour,
		fit: "contain",
		part: null,
		folder,
	});
	const colourMoved = findMeanDifference({
		a: await readFrames({ file: recoded }),
		b: await readFrames({ file: camera.asset.file }),
	});
	const differences =
		copied.length === expected.length
			? copied.map((frame, index) =>
					findDifference({ a: frame, b: expected[index] }),
				)
			: null;
	const difference = differences ? Math.max(0, ...differences) : null;
	return {
		codec,
		converted: plan.files.map(({ difference }) => difference),
		converting: Math.round(converting * 10) / 10,
		frames: copied.length,
		expectedFrames: expected.length,
		framesAreTheSources: difference === 0,
		colourMoved,
		colourKept: colourMoved < COLOUR_KEPT_WITHIN,
		mostDifferent: difference,
		// Which frames, in the join's order: the files are 15, 10 and 30 long.
		differingFrames: differences?.flatMap((most, index) =>
			most > 0 ? [[index, most]] : [],
		),
		writtenIn: describeColour(plan.colour),
		// Given to the encoder as I420 or as RGB, and in what colour space
		// (export/fast/convert.ts).
		...(await chooseColourInput({ target, colour: plan.colour }).then(
			({ input, samples }) => ({ input, samples: describeColour(samples) }),
		)),
		colours,
	};
}

// The test film's four quarters: black, white, mid grey and red, where a
// colour range or matrix gone wrong shows.
const QUARTERS = ["#000000", "#ffffff", "#808080", "#ff0000"];

/** A second of 1920×1080 film in the four quarters, written into the folder. */
async function makeTestFilm({
	folder,
	codec,
}: {
	folder: string;
	codec: VideoCodec;
}): Promise<DiskFile> {
	const [width, height] = [1920, 1080];
	const format = codec === "vp9" ? "webm" : "mp4";
	const { file, path } = await openFolderFile({
		folder,
		name: `quarters.${format}`,
	});
	const writer = file.writable.getWriter();
	checkEncoderColour();
	const canvas = new OffscreenCanvas(width, height);
	const context = canvas.getContext("2d");
	if (!context) throw new Error("no 2D canvas");
	for (const [index, colour] of QUARTERS.entries()) {
		context.fillStyle = colour;
		context.fillRect(
			(index % 2) * (width / 2),
			Math.floor(index / 2) * (height / 2),
			width / 2,
			height / 2,
		);
	}
	const output = new Output({
		format: createOutputFormat({ format, isStreamed: true }),
		target: new StreamTarget(
			new WritableStream({ write: (chunk) => writer.write(chunk) }),
			{ chunked: true, chunkSize: FILE_CHUNK_SIZE },
		),
	});
	const source = new CanvasSource(canvas, { codec, bitrate: 4e6 });
	output.addVideoTrack(source, { frameRate: 10 });
	await output.start();
	for (let frame = 0; frame < 10; frame++) {
		await source.add(frame / 10, 1 / 10);
	}
	await output.finalize();
	await writer.close();
	return adoptSavedFile({ path });
}

/** The mean colour in the middle of each quarter, of the frame at `time`. */
async function readQuarters({
	file,
	time,
}: {
	file: MediaFile;
	time: number;
}): Promise<number[][]> {
	const input = new Input({
		source: createMediaSource({ file }),
		formats: ALL_FORMATS,
	});
	try {
		const video = await input.getPrimaryVideoTrack();
		if (!video) throw new Error(`no video in ${file.name}`);
		const sample = await new VideoSampleSink(video).getSample(time);
		if (!sample) throw new Error(`no frame at ${time} s in ${file.name}`);
		const [width, height] = [video.displayWidth, video.displayHeight];
		const canvas = new OffscreenCanvas(width, height);
		const context = canvas.getContext("2d");
		if (!context) throw new Error("no 2D canvas");
		sample.draw(context, 0, 0, width, height);
		sample.close();
		return QUARTERS.map((_, index) => {
			const [x, y] = [
				(index % 2) * 0.5 + 0.2,
				Math.floor(index / 2) * 0.5 + 0.2,
			];
			const { data } = context.getImageData(
				Math.round(x * width),
				Math.round(y * height),
				Math.round(0.1 * width),
				Math.round(0.1 * height),
			);
			const sums = [0, 0, 0];
			for (let at = 0; at < data.length; at += 4) {
				for (const channel of [0, 1, 2]) sums[channel] += data[at + channel];
			}
			return sums.map((sum) => Math.round(sum / (data.length / 4)));
		});
	} finally {
		input.dispose();
	}
}

/**
 * docs/CONFORM.md, phase 4: a proxy made of a 1920×1080 film, into the app's
 * cache, and read back: its size, codec, no sound, and its colours beside the
 * film's.
 */
async function checkProxy({ folder }: { folder: string }) {
	const codec = await findEncodable({
		codecs: ["avc", "vp9"],
		width: 1920,
		height: 1080,
	});
	if (!codec) return "no H.264 or VP9 encoder here";
	const film = await makeTestFilm({ folder, codec });
	const asset = toAsset({
		id: "quarters",
		file: film,
		width: 1920,
		height: 1080,
		duration: 1,
	});
	const started = performance.now();
	const proxy = await makeProxy({ asset });
	const making = (performance.now() - started) / 1000;
	const input = new Input({
		source: createMediaSource({ file: proxy.file }),
		formats: ALL_FORMATS,
	});
	let read;
	try {
		const video = await input.getPrimaryVideoTrack();
		read = {
			codec: video?.codec ?? null,
			width: video?.displayWidth ?? 0,
			height: video?.displayHeight ?? 0,
			sound: (await input.getPrimaryAudioTrack()) !== null,
			duration: await input.computeDuration(),
		};
	} finally {
		input.dispose();
	}
	return {
		filmCodec: codec,
		...read,
		inTheCache:
			proxy.file instanceof DiskFile && proxy.file.path.includes("Proxies"),
		making: Math.round(making * 10) / 10,
		tags: {
			film: await readColour({ file: film }),
			proxy: await readColour({ file: proxy.file }),
		},
		colours: {
			drawn: [
				[0, 0, 0],
				[255, 255, 255],
				[128, 128, 128],
				[255, 0, 0],
			],
			film: await readQuarters({ file: film, time: 0.5 }),
			proxy: await readQuarters({ file: proxy.file, time: 0.5 }),
		},
	};
}
