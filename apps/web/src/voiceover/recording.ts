import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { create } from "zustand";
import type { EditorCore } from "@/core";
import { pickFolder } from "@/export/disk-target";
import { canReadDiskFiles } from "@/media/disk-file";
import { addMediaFile } from "@/media/replace";
import type { MediaTime } from "@/wasm";
import { placeSounds } from "./place";
import { nameTake, VoiceRecorder } from "./recorder";

/*
 * The Voice-over panel's recording (docs/VOICEOVER.md), kept here rather than
 * in the panel, so a take goes on while another tab is shown.
 */

/** The track takes go on. */
export const VOICEOVER_TRACK_NAME = "Voice-over";
/** Isolate voice: Reduce noise (docs/AUDIO-EFFECTS.md) at this strength. */
export const ISOLATE_STRENGTH = 0.85;
const COUNT_IN = 3;

export type RecordingStatus =
	| "off"
	| "opening"
	| "ready"
	| "counting"
	| "recording"
	| "saving";

interface RecordingState {
	recorder: VoiceRecorder | null;
	status: RecordingStatus;
	/** 3, 2, 1 before a take. */
	count: number;
	/** When the take started, by performance.now(). */
	startedAt: number;
	startTime: MediaTime | null;
	wasMuted: boolean;
	deviceId: string | undefined;
	/** The web view's echo cancellation, gain control and noise suppression. */
	processing: boolean;
	isolate: boolean;
	/** The timeline while recording: muted, or heard (in headphones). */
	monitor: "muted" | "heard";
	/** The desktop app's folder for takes. */
	folder: string | null;
	error: string | null;
}

export const useRecordingStore = create<RecordingState>()(() => ({
	recorder: null,
	status: "off",
	count: 0,
	startedAt: 0,
	startTime: null,
	wasMuted: false,
	deviceId: undefined,
	processing: false,
	isolate: false,
	monitor: "muted",
	folder: null,
	error: null,
}));

const set = (state: Partial<RecordingState>) =>
	useRecordingStore.setState(state);
const get = () => useRecordingStore.getState();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The desktop app's folder for takes and spoken cues: Music/MagnetCut until another is picked. */
export async function ensureVoiceFolder(): Promise<string | null> {
	if (!canReadDiskFiles()) return null;
	const { folder } = get();
	if (folder) return folder;
	const made = await invoke<string>("recordings_folder");
	set({ folder: made });
	return made;
}

export async function changeVoiceFolder(): Promise<void> {
	const picked = await pickFolder({
		title: "Where voice-overs go",
		besidePath: get().folder ?? undefined,
	});
	if (picked) set({ folder: picked });
}

// Counted up by each open and close: an open that a close overtook lets go.
let generation = 0;

/** Opens the microphone, or another one, with the choices made. */
export async function openMicrophone({
	deviceId,
	processing,
}: {
	deviceId?: string;
	processing: boolean;
}): Promise<void> {
	const { recorder, status } = get();
	if (status === "counting" || status === "recording" || status === "saving") {
		return;
	}
	const opening = ++generation;
	set({ recorder: null, status: "opening", error: null, deviceId, processing });
	await recorder?.close();
	try {
		const opened = await VoiceRecorder.open({ deviceId, processing });
		if (opening !== generation) {
			await opened.close();
			return;
		}
		set({ recorder: opened, status: "ready" });
	} catch (error) {
		if (opening !== generation) return;
		set({
			recorder: null,
			status: "off",
			error:
				error instanceof DOMException && error.name === "NotAllowedError"
					? "The microphone isn't allowed: allow MagnetCut in the system's privacy settings."
					: String(error),
		});
	}
}

export async function closeMicrophone(): Promise<void> {
	const { recorder } = get();
	generation += 1;
	set({ recorder: null, status: "off" });
	await recorder?.close();
}

/** After a 3-2-1, records from the playhead with the timeline playing. */
export async function startTake({
	editor,
}: {
	editor: EditorCore;
}): Promise<void> {
	const { recorder, status } = get();
	if (!recorder || status !== "ready") return;
	try {
		const folder = await ensureVoiceFolder();
		for (let count = COUNT_IN; count > 0; count--) {
			set({ status: "counting", count });
			await sleep(1000);
			if (get().status !== "counting") return;
		}
		const startTime = editor.playback.getCurrentTime();
		await recorder.start({ folder, name: nameTake({ date: new Date() }) });
		const wasMuted = editor.playback.isMuted();
		if (get().monitor === "muted") editor.playback.mute();
		editor.playback.play();
		set({
			status: "recording",
			startedAt: performance.now(),
			startTime,
			wasMuted,
		});
	} catch (error) {
		set({ status: "ready" });
		toast.error("Couldn't start recording", { description: String(error) });
	}
}

/** Stops counting in, before a take starts. */
export function cancelCountIn(): void {
	if (get().status === "counting") set({ status: "ready" });
}

/** Ends the take: kept, and put on the Voice-over track where it started. */
export async function stopTake({
	editor,
}: {
	editor: EditorCore;
}): Promise<void> {
	const { recorder, status, startTime, wasMuted, isolate } = get();
	if (!recorder || status !== "recording" || startTime === null) return;
	editor.playback.pause();
	if (!wasMuted) editor.playback.unmute();
	set({ status: "saving" });
	try {
		const file = await recorder.stop();
		const asset = await addMediaFile({ editor, file });
		if (!asset) throw new Error(`"${file.name}" couldn't be added.`);
		placeSounds({
			editor,
			trackName: VOICEOVER_TRACK_NAME,
			sounds: [
				{
					asset,
					startTime,
					params: isolate ? { noiseReduction: ISOLATE_STRENGTH } : undefined,
				},
			],
		});
		toast.success(`Take added: ${asset.name}`);
	} catch (error) {
		toast.error("The take couldn't be kept", { description: String(error) });
	} finally {
		set({ status: "ready", startTime: null });
	}
}
