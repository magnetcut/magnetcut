import {
	ALL_FORMATS,
	BufferTarget,
	canEncodeVideo,
	EncodedAudioPacketSource,
	EncodedPacket,
	EncodedPacketSink,
	EncodedVideoPacketSource,
	Input,
	Output,
	StreamTarget,
	type InputAudioTrack,
	type InputVideoTrack,
	type VideoCodec,
} from "mediabunny";
import { getWritingApp } from "@/desktop/app-info";
import { EXPORT_FORMAT_VALUES, type ExportFormat } from "@/export";
import type { ExportFile } from "@/export/disk-target";
import { createOutputFormat, getWritingAppTags } from "@/export/output-format";
import {
	FORMAT_CODECS,
	FORMAT_NAMES,
	type ExportAudioSettings,
} from "@/export/settings";
import { createMediaSource } from "@/media/disk-file";
import { mixTimelineAudio } from "@/media/audio-mix";
import type { MediaAsset } from "@/media/types";
import type { SceneTracks } from "@/timeline";
import {
	createSoundtrackSource,
	FILE_CHUNK_SIZE,
	SoundtrackFeed,
	type ExportOutput,
} from "@/services/renderer/scene-exporter";
import { TICKS_PER_SECOND } from "@/wasm";
import {
	buildFastSoundTracks,
	collectFastClips,
	hasAudibleAudioTracks,
	isSoundUnchanged,
	type FastClip,
	type PlacedClip,
} from "./clips";
import {
	getCopyStep,
	planClipCut,
	type ClipCut,
	type PacketLookup,
} from "./cuts";
import {
	openPieceEncoder,
	toBytes,
	type EncodedPiecePacket,
	type PieceEncoder,
} from "./encoder";
import {
	AvcParameterSets,
	isIdrPacket,
	parseAvcConfig,
	parseSps,
	readSpsColour,
} from "./h264";

// Fast mode's export (docs/FAST.md): the clips' packets copied into the file
// as they are, through mediabunny, with nothing decoded but what Smart Cut
// re-encodes; the sound copied too, or mixed and encoded where it can't be.

const VIDEO_CODEC_NAMES: Partial<Record<VideoCodec, string>> = {
	avc: "H.264",
	hevc: "HEVC",
	vp9: "VP9",
	av1: "AV1",
	vp8: "VP8",
};

function codecName({ codec }: { codec: VideoCodec | null }): string {
	return (
		(codec && VIDEO_CODEC_NAMES[codec]) ??
		codec?.toUpperCase() ??
		"an unknown codec"
	);
}

/** A description's bytes, as a key. */
function describeKey({ description }: { description: Uint8Array }): string {
	return Array.from(description, (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

/** A clip's file, opened. */
interface FastSource {
	asset: MediaAsset;
	input: Input;
	video: InputVideoTrack;
	videoConfig: VideoDecoderConfig;
	videoSink: EncodedPacketSink;
	lookup: PacketLookup<EncodedPacket>;
	/** The colour space of its pictures, which Smart Cut's are encoded in. */
	colour: VideoColorSpaceInit;
	audio: InputAudioTrack | null;
	audioConfig: AudioDecoderConfig | null;
	audioSink: EncodedPacketSink | null;
}

const VERIFIED = { verifyKeyPackets: true } as const;
const METADATA = { metadataOnly: true } as const;

/**
 * A file's packets as a cut sees them. In H.264 a cut starts at an IDR frame,
 * where the decoder starts afresh and may take the next parameter sets.
 */
function createLookup({
	sink,
	codec,
	config,
}: {
	sink: EncodedPacketSink;
	codec: VideoCodec;
	config: VideoDecoderConfig;
}): PacketLookup<EncodedPacket> {
	const lengthSize =
		codec === "avc" && config.description
			? parseAvcConfig({ data: toBytes({ source: config.description }) })
					.lengthSize
			: null;
	const canStartAt = (packet: EncodedPacket) =>
		lengthSize === null || isIdrPacket({ data: packet.data, lengthSize });
	return {
		frameAt: async (time) =>
			(await sink.getPacket(time, METADATA)) ?? sink.getFirstPacket(METADATA),
		keyAt: async (time) => {
			let key = await sink.getKeyPacket(time, VERIFIED);
			while (key && !canStartAt(key)) {
				const previous = await sink.getKeyPacket(
					key.timestamp - 1e-6,
					VERIFIED,
				);
				key =
					previous && previous.sequenceNumber < key.sequenceNumber
						? previous
						: null;
			}
			if (key) return key;
			let first = await sink.getFirstKeyPacket(VERIFIED);
			while (first && !canStartAt(first)) {
				first = await sink.getNextKeyPacket(first, VERIFIED);
			}
			return first;
		},
		nextKey: async (packet) => {
			let next = await sink.getNextKeyPacket(packet, VERIFIED);
			while (next && !canStartAt(next)) {
				next = await sink.getNextKeyPacket(next, VERIFIED);
			}
			return next;
		},
		packetsFrom: (packet) => sink.packets(packet, undefined, METADATA),
	};
}

/**
 * The colour space a file's pictures are in: H.264's from its SPS, which each
 * frame is decoded by, others' from the container. Limited range if unsaid.
 */
async function readColour({
	video,
	config,
}: {
	video: InputVideoTrack;
	config: VideoDecoderConfig;
}): Promise<VideoColorSpaceInit> {
	if (video.codec === "avc" && config.description) {
		const [sps] = parseAvcConfig({
			data: toBytes({ source: config.description }),
		}).sps;
		if (sps) {
			try {
				return readSpsColour({ unit: sps });
			} catch {
				// Unreadable: as the container says.
			}
		}
	}
	const colour = await video.getColorSpace();
	return {
		primaries: colour.primaries ?? null,
		transfer: colour.transfer ?? null,
		matrix: colour.matrix ?? null,
		fullRange: colour.fullRange ?? false,
	};
}

async function openSource({
	asset,
}: {
	asset: MediaAsset;
}): Promise<FastSource> {
	const input = new Input({
		source: createMediaSource({ file: asset.file }),
		formats: ALL_FORMATS,
	});
	try {
		const video = await input.getPrimaryVideoTrack();
		const videoConfig = await video?.getDecoderConfig();
		if (!video?.codec || !videoConfig) {
			throw new Error(`"${asset.name}" has no video Fast mode can copy.`);
		}
		const audio = await input.getPrimaryAudioTrack();
		const audioConfig = (await audio?.getDecoderConfig()) ?? null;
		const videoSink = new EncodedPacketSink(video);
		return {
			asset,
			input,
			video,
			videoConfig,
			videoSink,
			lookup: createLookup({
				sink: videoSink,
				codec: video.codec,
				config: videoConfig,
			}),
			colour: await readColour({ video, config: videoConfig }),
			audio,
			audioConfig,
			audioSink: audio && audioConfig ? new EncodedPacketSink(audio) : null,
		};
	} catch (error) {
		input.dispose();
		throw error;
	}
}

/** Each clip's file, opened once. */
async function openSources({
	clips,
}: {
	clips: FastClip[];
}): Promise<Map<string, FastSource>> {
	const sources = new Map<string, FastSource>();
	try {
		for (const { asset } of clips) {
			if (!sources.has(asset.id))
				sources.set(asset.id, await openSource({ asset }));
		}
		return sources;
	} catch (error) {
		for (const source of sources.values()) source.input.dispose();
		throw error;
	}
}

function sameBytes({
	a,
	b,
}: {
	a?: AllowSharedBufferSource;
	b?: AllowSharedBufferSource;
}): boolean {
	if (!a || !b) return a === b;
	const x = toBytes({ source: a });
	const y = toBytes({ source: b });
	return x.length === y.length && x.every((byte, i) => byte === y[i]);
}

/** The containers that take a codec, as players expect them. */
export function getFastFormats({
	codec,
}: {
	codec: VideoCodec;
}): ExportFormat[] {
	return EXPORT_FORMAT_VALUES.filter(
		(format) =>
			FORMAT_CODECS[format].video.some((candidate) => candidate === codec) ||
			(codec === "vp8" && (format === "webm" || format === "mkv")),
	);
}

function listNames({ names }: { names: string[] }): string {
	if (names.length <= 1) return names.join("");
	return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

/** Why the clips can't go into one file without re-encoding them; null if they can. */
function findJoinProblem({
	sources,
	format,
}: {
	sources: FastSource[];
	format: ExportFormat;
}): string | null {
	const [first, ...others] = sources;
	const codec = first.video.codec;
	if (!codec)
		return `"${first.asset.name}" is in a codec Fast mode can't copy.`;
	const formats = getFastFormats({ codec });
	if (!formats.includes(format)) {
		return formats.length > 0
			? `${FORMAT_NAMES[format]} can't hold ${codecName({ codec })} video: choose ${listNames({ names: formats.map((f) => FORMAT_NAMES[f]) })}.`
			: `Fast mode can't copy ${codecName({ codec })} video into a file.`;
	}
	for (const source of others) {
		const { video, videoConfig } = source;
		if (video.codec !== codec) {
			return `"${source.asset.name}" is ${codecName({ codec: video.codec })} and "${first.asset.name}" ${codecName({ codec })}: Fast mode joins clips in one codec only.`;
		}
		if (
			video.codedWidth !== first.video.codedWidth ||
			video.codedHeight !== first.video.codedHeight
		) {
			return `"${source.asset.name}" is ${video.codedWidth}×${video.codedHeight} and "${first.asset.name}" ${first.video.codedWidth}×${first.video.codedHeight}: Fast mode joins clips of one size only.`;
		}
		if (video.rotation !== first.video.rotation) {
			return `"${source.asset.name}" and "${first.asset.name}" are turned differently: Fast mode joins them only when they're the same way up.`;
		}
		// H.264's parameter sets are merged (h264.ts); other codecs' must match.
		const isMergeable =
			codec === "avc" &&
			!!videoConfig.description &&
			!!first.videoConfig.description;
		if (
			!isMergeable &&
			!sameBytes({
				a: videoConfig.description,
				b: first.videoConfig.description,
			})
		) {
			return `"${source.asset.name}" and "${first.asset.name}" were encoded differently: Fast mode joins them only when they were recorded the same way.`;
		}
	}
	return null;
}

/** Why Smart Cut can't re-encode this video here, so the cuts go to key frames; null if it can. */
/**
 * Whether a source's pictures are 8-bit 4:2:0, all the web views' encoders
 * take: from H.264's SPS, or VP9's profile and depth in its codec string.
 */
function isEightBit420({ source }: { source: FastSource }): boolean {
	const { codec } = source.video;
	if (codec === "avc" && source.videoConfig.description) {
		const [sps] = parseAvcConfig({
			data: toBytes({ source: source.videoConfig.description }),
		}).sps;
		if (!sps) return true;
		const { bitDepth, chromaFormatIdc } = parseSps({ unit: sps });
		return bitDepth === 8 && chromaFormatIdc === 1;
	}
	if (codec === "vp9") {
		const [, profile, , depth] = source.videoConfig.codec.split(".");
		return (profile ?? "00") === "00" && (depth ?? "08") === "08";
	}
	return true;
}

/** Why Smart Cut can't re-encode these sources, or null if it can. */
async function findSmartCutProblem({
	sources,
}: {
	sources: FastSource[];
}): Promise<string | null> {
	for (const source of sources) {
		const problem = await findSourceSmartCutProblem({ source });
		if (problem) return problem;
	}
	return null;
}

async function findSourceSmartCutProblem({
	source,
}: {
	source: FastSource;
}): Promise<string | null> {
	const { codec } = source.video;
	const name = codecName({ codec });
	if (codec !== "avc" && codec !== "vp9") {
		return `Smart Cut re-encodes H.264 and VP9 video; this one is ${name}, so it's cut at key frames, as No re-encoding does.`;
	}
	if (codec === "avc" && !source.videoConfig.description) {
		return "Smart Cut needs H.264 from an MP4, MOV or MKV file; this one is cut at key frames, as No re-encoding does.";
	}
	if (!isEightBit420({ source })) {
		return `Smart Cut re-encodes 8-bit 4:2:0 video; this ${name} is 10-bit or 4:2:2, so it's cut at key frames, as No re-encoding does.`;
	}
	const canDecode = await source.video.canDecode().catch(() => false);
	const canEncode = await canEncodeVideo(codec, {
		width: source.video.codedWidth,
		height: source.video.codedHeight,
	}).catch(() => false);
	if (!canDecode || !canEncode) {
		return `This computer can't ${canDecode ? "encode" : "decode"} ${name} here, so Smart Cut cuts at key frames, as No re-encoding does.`;
	}
	return null;
}

/** Whether the clips' sound can be copied as it is: the same codec and settings in each, unchanged. */
function canCopySound({
	placed,
	sources,
	tracks,
	format,
}: {
	placed: PlacedClip[];
	sources: Map<string, FastSource>;
	tracks: SceneTracks;
	format: ExportFormat;
}): boolean {
	const first = sources.get(placed[0].clip.asset.id);
	const config = first?.audioConfig;
	if (!first?.audio?.codec || !config || !first.audioSink) return false;
	const supported = createOutputFormat({
		format,
		isStreamed: true,
	}).getSupportedAudioCodecs();
	if (!supported.includes(first.audio.codec)) return false;
	// The audio tracks are mixed in: nothing to copy them with.
	if (hasAudibleAudioTracks({ tracks })) return false;
	return placed.every(({ clip }) => {
		const source = sources.get(clip.asset.id);
		const other = source?.audioConfig;
		return (
			!!source?.audioSink &&
			!!other &&
			source.audio?.codec === first.audio?.codec &&
			other.sampleRate === config.sampleRate &&
			other.numberOfChannels === config.numberOfChannels &&
			sameBytes({ a: other.description, b: config.description }) &&
			isSoundUnchanged({ element: clip.element, track: tracks.main })
		);
	});
}

/** What Export's panel says of a Fast mode export before it starts. */
export interface FastExportInfo {
	codec: VideoCodec | null;
	width: number;
	height: number;
	/** Why it can't be made; null if it can. */
	problem: string | null;
	/** Whether the problem is clips that differ, which converting them fixes (docs/CONFORM.md). */
	canConform: boolean;
	/** Why Smart Cut cuts at key frames instead, if it does. */
	smartFallback: string | null;
	/** The sound's codec, if it's copied. */
	copiedSound: string | null;
}

/** Looks at the clips' files for the export panel. */
export async function inspectFastExport({
	tracks,
	mediaAssets,
	mode,
	format,
	copiesSound,
}: {
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
	mode: "copy" | "smart";
	format: ExportFormat;
	/** Whether the sound is to be copied when it can. */
	copiesSound: boolean;
}): Promise<FastExportInfo> {
	const clips = collectFastClips({ tracks, mediaAssets });
	const none: FastExportInfo = {
		codec: null,
		width: 0,
		height: 0,
		problem:
			"Fast mode copies the video clips on the main track, and it has none.",
		canConform: false,
		smartFallback: null,
		copiedSound: null,
	};
	if (clips.length === 0) return none;
	let sources: Map<string, FastSource>;
	try {
		sources = await openSources({ clips });
	} catch (error) {
		return {
			...none,
			problem: error instanceof Error ? error.message : String(error),
		};
	}
	try {
		const ordered = [
			...new Set(clips.map((clip) => sources.get(clip.asset.id)!)),
		];
		const first = ordered[0];
		const placed = clips.map((clip) => ({
			clip,
			start: clip.from,
			end: clip.to,
			outStart: 0,
		}));
		const sound =
			copiesSound && canCopySound({ placed, sources, tracks, format })
				? (first.audio?.codec ?? null)
				: null;
		const problem = findJoinProblem({ sources: ordered, format });
		// The clips unlike each other, not a container that can't hold them.
		const canConform =
			problem !== null &&
			(!first.video.codec ||
				(ordered.length > 1 &&
					findJoinProblem({ sources: [first], format }) === null));
		return {
			codec: first.video.codec,
			width: first.video.displayWidth,
			height: first.video.displayHeight,
			problem,
			canConform,
			smartFallback:
				mode === "smart"
					? await findSmartCutProblem({ sources: ordered })
					: null,
			copiedSound: sound,
		};
	} finally {
		for (const source of sources.values()) source.input.dispose();
	}
}

// Behind by more than this, in seconds (a file whose sound ends early), the
// next clip's sound starts with its picture, after a gap.
const SOUND_GAP = 0.1;

/**
 * The clips' sound copied packet after packet, end to end: each clip's from
 * the packet that keeps it within half a packet of its picture, so the cuts
 * don't add up to a drift.
 */
async function* copySound({
	placed,
}: {
	placed: Array<PlacedClip & { source: FastSource }>;
}): AsyncGenerator<EncodedPacket, void, unknown> {
	let outTime = 0;
	for (const { source, start, end, outStart } of placed) {
		const sink = source.audioSink;
		if (!sink) continue;
		const outEnd = outStart + (end - start);
		if (outTime < outStart - SOUND_GAP) outTime = outStart;
		// What of the file should be heard where the sound has got to.
		const from = start + (outTime - outStart);
		let first = (await sink.getPacket(from)) ?? (await sink.getFirstPacket());
		if (first && from - first.timestamp > first.duration / 2) {
			first = await sink.getNextPacket(first);
		}
		if (!first) continue;
		for await (const packet of sink.packets(first)) {
			if (outTime + packet.duration / 2 >= outEnd) break;
			yield packet.clone({ timestamp: outTime });
			outTime += packet.duration;
		}
	}
}

/** The copied sound, handed over ahead of the frames. */
class CopiedSoundFeed {
	private readonly packets: AsyncGenerator<EncodedPacket, void, unknown>;
	private readonly source: EncodedAudioPacketSource;
	private readonly decoderConfig: AudioDecoderConfig;
	private time = 0;
	private isDone = false;

	constructor({
		packets,
		source,
		decoderConfig,
	}: {
		packets: AsyncGenerator<EncodedPacket, void, unknown>;
		source: EncodedAudioPacketSource;
		decoderConfig: AudioDecoderConfig;
	}) {
		this.packets = packets;
		this.source = source;
		this.decoderConfig = decoderConfig;
	}

	async addUntil({ time }: { time: number }) {
		while (!this.isDone && this.time <= time) {
			const next = await this.packets.next();
			if (next.done) {
				this.isDone = true;
				this.source.close();
				return;
			}
			const packet = next.value;
			await this.source.add(packet, { decoderConfig: this.decoderConfig });
			this.time = packet.timestamp + packet.duration;
		}
	}
}

interface SoundFeed {
	addUntil: (args: { time: number }) => Promise<void>;
}

/**
 * Makes a Fast mode export: the main track's clips copied one after another,
 * with No re-encoding (`copy`) from the key frame before each cut, with Smart
 * Cut (`smart`) from the cut, its first and last frames re-encoded where
 * they're not on a key frame. Null if cancelled.
 */
export async function exportFast({
	tracks,
	mediaAssets,
	mode,
	format,
	audio,
	file,
	onProgress,
	isCancelled,
}: {
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
	mode: "copy" | "smart";
	format: ExportFormat;
	/** The sound's settings, if there's sound; copied when it can be if they say so. */
	audio: ExportAudioSettings | null;
	file?: ExportFile;
	onProgress?: (progress: number) => void;
	isCancelled: () => boolean;
}): Promise<ExportOutput | null> {
	const clips = collectFastClips({ tracks, mediaAssets });
	let sources: Map<string, FastSource>;
	try {
		if (clips.length === 0) {
			throw new Error(
				"Fast mode copies the video clips on the main track, and it has none.",
			);
		}
		sources = await openSources({ clips });
	} catch (error) {
		// Nothing's written yet: the file picked isn't left there empty.
		await file?.discard();
		throw error;
	}
	let encoder: PieceEncoder | null = null;
	let soundtrack: AsyncGenerator<AudioBuffer, void, undefined> | null = null;
	try {
		const ordered = [
			...new Set(clips.map((clip) => sources.get(clip.asset.id)!)),
		];
		const first = ordered[0];
		const problem = findJoinProblem({ sources: ordered, format });
		if (problem) throw new Error(problem);
		const codec = first.video.codec!;

		if (
			mode === "smart" &&
			(codec === "avc" || codec === "vp9") &&
			!(await findSmartCutProblem({ sources: ordered }))
		) {
			const stats = await first.video.computePacketStats(200);
			encoder = await openPieceEncoder({
				codec,
				sourceCodec: first.videoConfig.codec,
				width: first.video.codedWidth,
				height: first.video.codedHeight,
				sourceBitrate: stats.averageBitrate,
				frameRate: stats.averagePacketRate || 30,
			});
		}
		const smart = !!encoder;

		const placed: Array<
			PlacedClip & { source: FastSource; cut: ClipCut<EncodedPacket> }
		> = [];
		let outTime = 0;
		for (const clip of clips) {
			const source = sources.get(clip.asset.id)!;
			const cut = await planClipCut({
				lookup: source.lookup,
				from: clip.from,
				to: clip.to,
				smart,
			});
			if (!cut) continue;
			placed.push({
				clip,
				source,
				cut,
				start: cut.start,
				end: cut.end,
				outStart: outTime,
			});
			outTime += cut.end - cut.start;
		}
		if (placed.length === 0)
			throw new Error("The clips have no frames to copy.");
		const total = outTime;
		// Every cut on a key frame: nothing to re-encode after all.
		if (
			!placed.some(({ cut }) => cut.headEnd !== null || cut.tailStart !== null)
		) {
			encoder?.close();
			encoder = null;
		}

		// H.264's parameter sets: every source's, and the encoder's, in one avcC.
		let decoderConfig: VideoDecoderConfig = first.videoConfig;
		const rewrites = new Map<FastSource, (data: Uint8Array) => Uint8Array>();
		// The encoder's, one for each description it makes, by its bytes.
		const encodedRewrites = new Map<string, (data: Uint8Array) => Uint8Array>();
		if (codec === "avc" && first.videoConfig.description) {
			const parse = (description: AllowSharedBufferSource) =>
				parseAvcConfig({ data: toBytes({ source: description }) });
			const sets = new AvcParameterSets({
				primary: parse(first.videoConfig.description),
			});
			for (const source of ordered) {
				if (source.videoConfig.description) {
					rewrites.set(
						source,
						sets.add({ config: parse(source.videoConfig.description) }).rewrite,
					);
				}
			}
			if (encoder) {
				// What the encoder's parameter sets will be is known only from a
				// frame of each source: they follow the frames' colour space.
				const surveyed = new Set<FastSource>();
				for (const { source, cut } of placed) {
					const at = cut.headEnd !== null ? cut.start : cut.tailStart;
					if (at === null || surveyed.has(source)) continue;
					surveyed.add(source);
					const description = await encoder.survey({
						track: source.video,
						at,
						colour: source.colour,
					});
					const key = description && describeKey({ description });
					if (key && !encodedRewrites.has(key)) {
						encodedRewrites.set(
							key,
							sets.add({ config: parse(description) }).rewrite,
						);
					}
				}
			}
			decoderConfig = { ...first.videoConfig, description: sets.description };
		}
		const rewriteEncoded = ({ packet, description }: EncodedPiecePacket) => {
			if (codec !== "avc") return packet;
			const rewrite =
				description && encodedRewrites.get(describeKey({ description }));
			if (!rewrite)
				throw new Error("The encoder changed its settings part way");
			return packet.clone({ data: rewrite(packet.data) });
		};

		const writingApp = await getWritingApp();
		const target = file
			? new StreamTarget(file.writable, {
					chunked: true,
					chunkSize: FILE_CHUNK_SIZE,
				})
			: new BufferTarget();
		const output = new Output({
			format: createOutputFormat({ format, isStreamed: !!file, writingApp }),
			target,
		});
		output.setMetadataTags(getWritingAppTags({ format, writingApp }));
		const videoSource = new EncodedVideoPacketSource(codec);
		const sameTimescale = ordered.every(
			(source) => source.video.timeResolution === first.video.timeResolution,
		);
		output.addVideoTrack(videoSource, {
			rotation: first.video.rotation,
			// The files' time base, in MP4's timescale; Matroska rounds to it.
			frameRate:
				(format === "mp4" || format === "mov") && sameTimescale
					? first.video.timeResolution
					: undefined,
		});

		let sound: SoundFeed | null = null;
		const copied =
			audio?.passthrough && canCopySound({ placed, sources, tracks, format });
		if (copied && first.audio?.codec && first.audioConfig) {
			const audioSource = new EncodedAudioPacketSource(first.audio.codec);
			output.addAudioTrack(audioSource);
			sound = new CopiedSoundFeed({
				packets: copySound({ placed }),
				source: audioSource,
				decoderConfig: first.audioConfig,
			});
		} else if (audio) {
			soundtrack = mixTimelineAudio({
				tracks: buildFastSoundTracks({ tracks, placed }),
				mediaAssets,
				duration: Math.round(total * TICKS_PER_SECOND),
				loudness: audio.loudness,
			});
			if (soundtrack) {
				const audioSource = await createSoundtrackSource({
					format,
					audioSettings: audio,
				});
				output.addAudioTrack(audioSource);
				sound = new SoundtrackFeed({
					windows: soundtrack,
					source: audioSource,
					isMono: audio.channels === 1,
				});
			}
		}

		await output.start();
		let isFirstPacket = true;
		const addVideo = async ({ packet }: { packet: EncodedPacket }) => {
			await sound?.addUntil({ time: packet.timestamp });
			await videoSource.add(
				packet,
				isFirstPacket ? { decoderConfig } : undefined,
			);
			isFirstPacket = false;
			onProgress?.(Math.min(1, packet.timestamp / total));
		};
		const cancel = async () => {
			await output.cancel();
			await file?.discard();
			return null;
		};

		for (const { source, cut, outStart } of placed) {
			const offset = outStart - cut.start;
			const encodePiece = async ({
				from,
				to,
			}: {
				from: number;
				to: number;
			}) => {
				if (!encoder) throw new Error("Smart Cut has no encoder");
				const encoded = await encoder.encode({
					track: source.video,
					from,
					to,
					offset,
					colour: source.colour,
				});
				for (const piece of encoded)
					await addVideo({ packet: rewriteEncoded(piece) });
			};
			if (cut.headEnd !== null)
				await encodePiece({ from: cut.start, to: cut.headEnd });
			if (isCancelled()) return await cancel();
			if (cut.copyFrom) {
				const rewrite = rewrites.get(source) ?? ((data: Uint8Array) => data);
				for await (const packet of source.videoSink.packets(cut.copyFrom)) {
					const step = getCopyStep({
						packet,
						copyFrom: cut.copyFrom,
						until: cut.copyUntil,
					});
					if (step === "stop") break;
					if (step === "skip") continue;
					await addVideo({
						packet: packet.clone({
							data: rewrite(packet.data),
							timestamp: Math.max(0, packet.timestamp + offset),
						}),
					});
					if (isCancelled()) return await cancel();
				}
			}
			if (cut.tailStart !== null)
				await encodePiece({ from: cut.tailStart, to: cut.copyUntil });
			if (isCancelled()) return await cancel();
		}

		await sound?.addUntil({ time: Infinity });
		videoSource.close();
		await output.finalize();
		onProgress?.(1);
		if (file) return { file };
		const buffer = target instanceof BufferTarget ? target.buffer : null;
		if (!buffer) throw new Error("Failed to export video");
		return { buffer };
	} catch (error) {
		await file?.discard();
		throw error;
	} finally {
		encoder?.close();
		await soundtrack?.return(undefined);
		for (const source of sources.values()) source.input.dispose();
	}
}
