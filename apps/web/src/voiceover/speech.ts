import { invoke } from "@tauri-apps/api/core";
import type { EditorCore } from "@/core";
import { adoptSavedFile, openFolderFile } from "@/export/disk-target";
import { addMediaFile } from "@/media/replace";
import type { MediaAsset } from "@/media/types";
import { getSubtitleLines } from "@/subtitles/track";
import type { TextTrack } from "@/timeline";
import { mediaTimeFromSeconds } from "@/wasm";
import { placeSounds, type PlacedSound } from "./place";

/*
 * The subtitles spoken (docs/VOICEOVER.md): each cue sent to a voice by the
 * desktop app (apps/desktop/src/speech.rs), which holds the keys, and put on
 * the timeline at its cue, sped up to fit if it's a little long.
 */

export type SpeechProvider = "system" | "elevenlabs" | "openai";

export const SPEECH_PROVIDERS: { value: SpeechProvider; label: string }[] = [
	{ value: "system", label: "This computer's voices" },
	{ value: "elevenlabs", label: "ElevenLabs" },
	{ value: "openai", label: "OpenAI" },
];

export interface SpeechVoice {
	id: string;
	name: string;
	language: string | null;
	description: string | null;
}

export interface SpeechModel {
	id: string;
	name: string;
}

export const speechApi = {
	keys: () => invoke<{ elevenlabs: boolean; openai: boolean }>("speech_keys"),
	setKey: ({
		provider,
		key,
	}: {
		provider: Exclude<SpeechProvider, "system">;
		key: string | null;
	}) => invoke<void>("set_speech_key", { provider, key }),
	voices: ({ provider }: { provider: SpeechProvider }) =>
		invoke<SpeechVoice[]>("speech_voices", { provider }),
	models: ({ provider }: { provider: SpeechProvider }) =>
		invoke<SpeechModel[]>("speech_models", { provider }),
	quota: ({ provider }: { provider: SpeechProvider }) =>
		invoke<{ used: number; limit: number } | null>("speech_quota", {
			provider,
		}),
};

/** How a cue is spoken, all of which makes it sound different. */
export interface SpeechChoice {
	provider: SpeechProvider;
	voice: string;
	model: string | null;
	instructions: string | null;
}

/** A cue's text as it's spoken: one line, its tags taken out. */
export function toSpokenText({ text }: { text: string }): string {
	return text
		.replace(/<[^>]*>/g, "")
		.replace(/\{\\[^}]*\}/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** What a cue spoken this way is known by: the same text and voice, the same key. */
export function hashSpeech({
	choice,
	text,
}: {
	choice: SpeechChoice;
	text: string;
}): string {
	const input = JSON.stringify([
		choice.provider,
		choice.voice,
		choice.model ?? "",
		choice.instructions ?? "",
		text,
	]);
	// FNV-1a, twice over with different seeds: 16 hex digits.
	const fnv = (seed: number) => {
		let hash = seed >>> 0;
		for (let index = 0; index < input.length; index++) {
			hash ^= input.charCodeAt(index);
			hash = Math.imul(hash, 0x01000193) >>> 0;
		}
		return hash.toString(16).padStart(8, "0");
	};
	return fnv(0x811c9dc5) + fnv(0x01234567);
}

/** The file a spoken cue is kept in: a few of its words, and its key. */
export function nameSpokenFile({
	text,
	hash,
}: {
	text: string;
	hash: string;
}): string {
	const words = text
		.replace(/[\\/:*?"<>|]/g, "")
		.slice(0, 32)
		.trim();
	return `${words || "Cue"} · ${hash}.wav`;
}

/** Sped up by at most this, its pitch kept, to fit a cue. */
export const MAX_SPEED_UP = 1.25;
// Longer than its cue by less than this still fits.
const FIT_TOLERANCE = 0.05;

/** How a cue's speech is played: sped up to fit, if it can be, and whether it still runs over. */
export function fitSpeech({
	speech,
	start,
	end,
	nextStart,
}: {
	/** Seconds. */
	speech: number;
	start: number;
	end: number;
	/** The next cue's start; none for the last. */
	nextStart: number | null;
}): { rate: number; length: number; isTooLong: boolean } {
	const room = Math.max(0.01, end - start);
	const rate =
		speech > room + FIT_TOLERANCE ? Math.min(MAX_SPEED_UP, speech / room) : 1;
	const length = speech / rate;
	const isTooLong =
		length > room + FIT_TOLERANCE ||
		(nextStart !== null && start + length > nextStart + FIT_TOLERANCE);
	return { rate, length, isTooLong };
}

export interface CueToSpeak {
	start: number;
	end: number;
	nextStart: number | null;
	text: string;
	hash: string;
	/** Spoken before: in the project's media already. */
	asset: MediaAsset | null;
}

/** The track's cues with text, each with what's been spoken of it before. */
export function listCuesToSpeak({
	track,
	choice,
	mediaAssets,
}: {
	track: TextTrack;
	choice: SpeechChoice;
	mediaAssets: MediaAsset[];
}): CueToSpeak[] {
	const lines = getSubtitleLines({ track })
		.map(({ cue }) => ({ ...cue, text: toSpokenText({ text: cue.text }) }))
		.filter(({ text }) => text.length > 0);
	return lines.map((cue, index) => {
		const hash = hashSpeech({ choice, text: cue.text });
		return {
			start: cue.start,
			end: cue.end,
			nextStart: lines[index + 1]?.start ?? null,
			text: cue.text,
			hash,
			asset:
				mediaAssets.find((asset) => asset.name.endsWith(` · ${hash}.wav`)) ??
				null,
		};
	});
}

/** The track the spoken cues go on. */
export const SPOKEN_TRACK_NAME = "Spoken subtitles";

export interface SpeakProgress {
	index: number;
	count: number;
}

export interface SpeakResult {
	spoken: number;
	reused: number;
	/** The cues that run over even sped up: their text wants shortening. */
	tooLong: { start: number; text: string }[];
	cancelled: boolean;
}

/** One cue spoken, kept in `folder`, and given to the project. */
async function speakCue({
	editor,
	cue,
	choice,
	folder,
}: {
	editor: EditorCore;
	cue: CueToSpeak;
	choice: SpeechChoice;
	folder: string;
}): Promise<MediaAsset> {
	const bytes = await invoke<ArrayBuffer>("speak", {
		provider: choice.provider,
		text: cue.text,
		voice: choice.voice,
		model: choice.model,
		instructions: choice.instructions,
	});
	const { file, path } = await openFolderFile({
		folder,
		name: nameSpokenFile({ text: cue.text, hash: cue.hash }),
	});
	const writer = file.writable.getWriter();
	try {
		await writer.write({
			type: "write",
			data: new Uint8Array(bytes),
			position: 0,
		});
		await writer.close();
	} catch (error) {
		writer.releaseLock();
		await file.discard();
		throw error;
	}
	const asset = await addMediaFile({
		editor,
		file: await adoptSavedFile({ path }),
	});
	if (!asset) throw new Error("The spoken cue couldn't be added.");
	return asset;
}

/**
 * The cues spoken one after another (providers limit how many at once), those
 * spoken before taken from the project, and all put on the timeline in one
 * step that Undo takes back, also after a cancel or a failure part way.
 */
export async function speakCues({
	editor,
	cues,
	choice,
	folder,
	signal,
	onProgress,
}: {
	editor: EditorCore;
	cues: CueToSpeak[];
	choice: SpeechChoice;
	folder: string;
	signal: AbortSignal;
	onProgress: (progress: SpeakProgress) => void;
}): Promise<SpeakResult> {
	const sounds: PlacedSound[] = [];
	const result: SpeakResult = {
		spoken: 0,
		reused: 0,
		tooLong: [],
		cancelled: false,
	};
	try {
		for (const [index, cue] of cues.entries()) {
			if (signal.aborted) {
				result.cancelled = true;
				break;
			}
			onProgress({ index, count: cues.length });
			const asset =
				cue.asset ?? (await speakCue({ editor, cue, choice, folder }));
			if (cue.asset) result.reused += 1;
			else result.spoken += 1;
			const fit = fitSpeech({
				speech: asset.duration ?? 0,
				start: cue.start,
				end: cue.end,
				nextStart: cue.nextStart,
			});
			if (fit.isTooLong)
				result.tooLong.push({ start: cue.start, text: cue.text });
			sounds.push({
				asset,
				startTime: mediaTimeFromSeconds({ seconds: cue.start }),
				duration: mediaTimeFromSeconds({ seconds: fit.length }),
				retime:
					fit.rate !== 1 ? { rate: fit.rate, maintainPitch: true } : undefined,
			});
		}
	} finally {
		placeSounds({ editor, trackName: SPOKEN_TRACK_NAME, sounds });
	}
	return result;
}
