import {
	detectSpeech,
	fitSubtitlesToSpeech,
	timeLinesToWords,
	type HeardWord,
	type SpeechFit,
	type SpeechSpan,
} from "magnetcut-wasm";
import type { EditorCore } from "@/core";
import { extractTimelineAudio } from "@/media/mediabunny";
import { decodeAudioToFloat32 } from "@/media/audio";
import type { TextTrack } from "@/timeline";
import type { CaptionChunk, TranscriptionSegment } from "@/transcription/types";
import {
	getCuts,
	getSubtitleLines,
	retimeTrack,
	snapTrack,
	type ElementUpdate,
} from "./track";

// Syncing subtitles to the speech, in the editor (docs/SUBTITLES.md, phase
// 4), with the Rust core's alignment.

// The soundtrack's rate for finding speech: speech needs no more.
const SPEECH_SAMPLE_RATE = 16_000;

/** Whisper's segments as words, each placed in its segment in proportion to
 * its length: what auto-sync aligns lines to, until Whisper gives words. */
export function getWordsFromSegments({
	segments,
}: {
	segments: TranscriptionSegment[];
}): HeardWord[] {
	const words: HeardWord[] = [];
	for (const segment of segments) {
		const parts = segment.text.split(/\s+/).filter(Boolean);
		const total = parts.reduce((sum, part) => sum + part.length, 0);
		const span = Math.max(0, segment.end - segment.start);
		let at = segment.start;
		for (const part of parts) {
			const length = total > 0 ? (span * part.length) / total : 0;
			words.push({ text: part, start: at, end: at + length });
			at += length;
		}
	}
	return words;
}

/** Lines of text timed to the speech heard: as captions, or none if no
 * word matched. Blank lines are left out. To Whisper's words where it timed
 * them, else to its segments' words, spread over each. */
export function syncLinesToSpeech({
	text,
	segments,
	words,
}: {
	text: string;
	segments: TranscriptionSegment[];
	words?: TranscriptionSegment[];
}): CaptionChunk[] | null {
	const lines = text
		.split(/\n\s*\n|\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	if (lines.length === 0) return null;
	const heard =
		words && words.length > 0
			? words.map(({ text: word, start, end }) => ({ text: word, start, end }))
			: getWordsFromSegments({ segments });
	const cues = timeLinesToWords(lines, heard);
	if (!cues) return null;
	return cues.map((cue) => ({
		text: cue.text,
		startTime: cue.start,
		duration: Math.max(0, cue.end - cue.start),
	}));
}

/** When someone's speaking on the timeline, roughly, by loudness. */
export async function findTimelineSpeech({
	editor,
}: {
	editor: EditorCore;
}): Promise<SpeechSpan[]> {
	const audioBlob = await extractTimelineAudio({
		tracks: editor.scenes.getActiveScene().tracks,
		mediaAssets: editor.media.getAssets(),
		totalDuration: editor.timeline.getTotalDuration(),
	});
	const { samples } = await decodeAudioToFloat32({
		audioBlob,
		sampleRate: SPEECH_SAMPLE_RATE,
	});
	return detectSpeech(samples, SPEECH_SAMPLE_RATE);
}

/** How to line the track up with the speech, and the updates that do it:
 * none with nothing to go on. */
export function fitTrackToSpeech({
	track,
	speech,
}: {
	track: TextTrack;
	speech: SpeechSpan[];
}): { fit: SpeechFit; updates: ElementUpdate[] } | null {
	const cues = getSubtitleLines({ track }).map(({ cue }) => cue);
	const fit = fitSubtitlesToSpeech(cues, speech);
	if (!fit) return null;
	return { fit, updates: retimeTrack({ track, retime: fit.retime }) };
}

/** The track's lines snapped to where speech starts and ends, and to cuts. */
export async function snapTrackToSpeech({
	editor,
	track,
}: {
	editor: EditorCore;
	track: TextTrack;
}): Promise<ElementUpdate[]> {
	const speech = await findTimelineSpeech({ editor });
	const cuts = getCuts({ tracks: editor.scenes.getActiveScene().tracks });
	return snapTrack({
		track,
		starts: [...speech.map(({ start }) => start), ...cuts],
		ends: [...speech.map(({ end }) => end), ...cuts],
	});
}
