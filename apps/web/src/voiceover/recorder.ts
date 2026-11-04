import {
	adoptSavedFile,
	openFolderFile,
	type ExportFile,
} from "@/export/disk-target";
import type { MediaFile } from "@/media/disk-file";
import { buildWavHeader, floatsToPcm16, WAV_HEADER_BYTES } from "./wav";

/*
 * Recording a voice-over (docs/VOICEOVER.md): the microphone's samples, by an
 * AudioWorklet, written as they come into a WAV file, mono 16-bit. In the
 * desktop app the file is on disk from the first second, its header brought
 * up to date every second; in a browser it's kept in memory until Stop.
 */

const CAPTURE_PROCESSOR = "magnetcut-capture";

// The worklet hands the main thread each block it hears while recording.
const CAPTURE_SOURCE = `
class Capture extends AudioWorkletProcessor {
	constructor() {
		super();
		this.isRecording = false;
		this.port.onmessage = (event) => { this.isRecording = event.data === "start"; };
	}
	process(inputs) {
		const input = inputs[0];
		if (this.isRecording && input && input.length > 0) {
			this.port.postMessage(input.map((channel) => channel.slice()));
		}
		return true;
	}
}
registerProcessor("${CAPTURE_PROCESSOR}", Capture);
`;

// The header is written again after this many seconds of samples.
const HEADER_EVERY_SECONDS = 1;

/** The microphones there are: their names once the page may use one. */
export async function listInputs(): Promise<MediaDeviceInfo[]> {
	const devices = await navigator.mediaDevices.enumerateDevices();
	return devices.filter((device) => device.kind === "audioinput");
}

/** Where a recording goes as it's made. */
interface RecordingSink {
	write({
		bytes,
		position,
	}: {
		bytes: Uint8Array<ArrayBuffer>;
		position: number;
	}): Promise<void>;
	finish(): Promise<MediaFile>;
	discard(): Promise<void>;
}

/** A file on disk, in a folder the desktop app was given. */
async function openDiskSink({
	folder,
	name,
}: {
	folder: string;
	name: string;
}): Promise<RecordingSink> {
	const { file, path }: { file: ExportFile; path: string } =
		await openFolderFile({
			folder,
			name,
		});
	const writer = file.writable.getWriter();
	return {
		write: ({ bytes, position }) =>
			writer.write({ type: "write", data: bytes, position }),
		finish: async () => {
			await writer.close();
			return adoptSavedFile({ path });
		},
		discard: async () => {
			writer.releaseLock();
			await file.discard();
		},
	};
}

/** In memory, for a browser. */
function openMemorySink({ name }: { name: string }): RecordingSink {
	const parts = new Map<number, Uint8Array<ArrayBuffer>>();
	return {
		write: async ({ bytes, position }) => {
			parts.set(position, bytes);
		},
		finish: async () => {
			const ordered = [...parts.entries()]
				.sort(([a], [b]) => a - b)
				.map(([, bytes]) => bytes);
			return new File(ordered, name, { type: "audio/wav" });
		},
		discard: async () => {
			parts.clear();
		},
	};
}

/** A take's name: when it was recorded. */
export function nameTake({ date }: { date: Date }): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return `Voice-over ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}.${pad(date.getMinutes())}.${pad(date.getSeconds())}.wav`;
}

/** The microphone, open: its level shown, and recorded when asked. */
export class VoiceRecorder {
	private readonly stream: MediaStream;
	private readonly context: AudioContext;
	private readonly node: AudioWorkletNode;
	private readonly analyser: AnalyserNode;
	private readonly levels: Float32Array<ArrayBuffer>;
	private sink: RecordingSink | null = null;
	private written = 0;
	private sinceHeader = 0;
	private pending: Promise<void> = Promise.resolve();
	private failure: unknown = null;

	private constructor({
		stream,
		context,
		node,
		analyser,
	}: {
		stream: MediaStream;
		context: AudioContext;
		node: AudioWorkletNode;
		analyser: AnalyserNode;
	}) {
		this.stream = stream;
		this.context = context;
		this.node = node;
		this.analyser = analyser;
		this.levels = new Float32Array(analyser.fftSize);
		node.port.onmessage = (event: MessageEvent<Float32Array[]>) =>
			this.receive({ channels: event.data });
	}

	/**
	 * Opens a microphone (the system's default if no id): the web view's echo
	 * cancellation, gain control and noise suppression only if `processing`,
	 * as they colour the voice.
	 */
	static async open({
		deviceId,
		processing,
	}: {
		deviceId?: string;
		processing: boolean;
	}): Promise<VoiceRecorder> {
		const stream = await navigator.mediaDevices.getUserMedia({
			audio: {
				deviceId: deviceId ? { exact: deviceId } : undefined,
				echoCancellation: processing,
				autoGainControl: processing,
				noiseSuppression: processing,
				channelCount: 1,
			},
		});
		const context = new AudioContext();
		try {
			const url = URL.createObjectURL(
				new Blob([CAPTURE_SOURCE], { type: "text/javascript" }),
			);
			try {
				await context.audioWorklet.addModule(url);
			} finally {
				URL.revokeObjectURL(url);
			}
			const source = context.createMediaStreamSource(stream);
			// One silent output, to the speakers: a node nothing pulls on isn't
			// run in every web view.
			const node = new AudioWorkletNode(context, CAPTURE_PROCESSOR, {
				numberOfOutputs: 1,
			});
			const analyser = context.createAnalyser();
			analyser.fftSize = 1024;
			source.connect(node);
			source.connect(analyser);
			node.connect(context.destination);
			// Opened after a click, so it may run: the meter moves before a take.
			await context.resume();
			return new VoiceRecorder({ stream, context, node, analyser });
		} catch (error) {
			for (const track of stream.getTracks()) track.stop();
			await context.close();
			throw error;
		}
	}

	get sampleRate(): number {
		return this.context.sampleRate;
	}

	get isRecording(): boolean {
		return this.sink !== null;
	}

	/** The loudest sample just now, 0 to 1, for the meter. */
	getLevel(): number {
		this.analyser.getFloatTimeDomainData(this.levels);
		let peak = 0;
		for (const sample of this.levels) peak = Math.max(peak, Math.abs(sample));
		return Math.min(1, peak);
	}

	/** Starts writing: to `folder` in the desktop app, in memory without one. */
	async start({
		folder,
		name,
	}: {
		folder: string | null;
		name: string;
	}): Promise<void> {
		if (this.sink) throw new Error("Already recording");
		const sink = folder
			? await openDiskSink({ folder, name })
			: openMemorySink({ name });
		this.written = 0;
		this.sinceHeader = 0;
		this.failure = null;
		this.pending = sink.write({ bytes: this.header(), position: 0 });
		this.sink = sink;
		await this.context.resume();
		this.node.port.postMessage("start");
	}

	/** Stops and gives the take, the header's sizes filled in. */
	async stop(): Promise<MediaFile> {
		const sink = this.sink;
		if (!sink) throw new Error("Not recording");
		this.node.port.postMessage("stop");
		this.sink = null;
		try {
			await this.pending;
			if (this.failure) throw this.failure;
			await sink.write({ bytes: this.header(), position: 0 });
			return await sink.finish();
		} catch (error) {
			await sink.discard().catch(() => undefined);
			throw error;
		}
	}

	/** Stops without keeping anything. */
	async cancel(): Promise<void> {
		const sink = this.sink;
		this.node.port.postMessage("stop");
		this.sink = null;
		await this.pending.catch(() => undefined);
		await sink?.discard();
	}

	/** Lets the microphone go. */
	async close(): Promise<void> {
		if (this.sink) await this.cancel();
		for (const track of this.stream.getTracks()) track.stop();
		await this.context.close();
	}

	private header(): Uint8Array<ArrayBuffer> {
		return buildWavHeader({
			sampleRate: this.context.sampleRate,
			channels: 1,
			dataBytes: this.written,
		});
	}

	private receive({ channels }: { channels: Float32Array[] }) {
		const sink = this.sink;
		const [first] = channels;
		if (!sink || !first) return;
		// Mono: a microphone that gives two channels is mixed down.
		const mono =
			channels.length === 1
				? first
				: first.map(
						(_, index) =>
							channels.reduce(
								(sum, channel) => sum + (channel[index] ?? 0),
								0,
							) / channels.length,
					);
		const bytes = floatsToPcm16({ channels: [mono] });
		const position = WAV_HEADER_BYTES + this.written;
		this.written += bytes.length;
		this.sinceHeader += mono.length;
		const writeHeader =
			this.sinceHeader >= this.sampleRate * HEADER_EVERY_SECONDS;
		if (writeHeader) this.sinceHeader = 0;
		const header = writeHeader ? this.header() : null;
		this.pending = this.pending
			.then(async () => {
				await sink.write({ bytes, position });
				if (header) await sink.write({ bytes: header, position: 0 });
			})
			.catch((error: unknown) => {
				this.failure ??= error;
			});
	}
}
