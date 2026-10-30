import {
	ALL_FORMATS,
	EncodedPacketSink,
	Input,
	type AudioCodec,
	type EncodedPacket,
	type InputAudioTrack,
} from "mediabunny";
import type { SceneTracks } from "@/timeline";
import type { MediaAsset } from "@/media/types";
import { createMediaSource } from "@/media/disk-file";
import { findPassthroughClip } from "@/media/audio-mix";
import type { ExportFormat } from "./index";
import { createOutputFormat } from "./output-format";

// Audio passthrough (docs/NATIVE.md, phase 3): when the whole soundtrack is
// one file's sound, uncut, Export copies its packets instead of decoding,
// mixing and encoding them again, as HandBrake's passthru does.

// Packets read for the bitrate the size estimate needs.
const BITRATE_SAMPLE_PACKETS = 200;

/** A source's sound, ready to copy into the export. */
export interface AudioPassthrough {
	/** The file it's copied from. */
	file: MediaAsset["file"];
	/** Where the timeline stops hearing it, in seconds. */
	end: number;
	track: InputAudioTrack;
	codec: AudioCodec;
	numberOfChannels: number;
	sampleRate: number;
	/** About, in bits a second. */
	bitrate: number;
	/** Its packets in order, up to where the timeline stops hearing it. */
	packets: () => AsyncGenerator<EncodedPacket, void, unknown>;
	decoderConfig: AudioDecoderConfig;
	close: () => void;
}

/**
 * The timeline's sound to copy, if it's one file's, uncut, in a codec the
 * container takes: null otherwise, and the soundtrack is mixed and encoded.
 */
export async function openAudioPassthrough({
	tracks,
	mediaAssets,
	duration,
	format,
}: {
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
	/** The timeline's, in ticks. */
	duration: number;
	format: ExportFormat;
}): Promise<AudioPassthrough | null> {
	const clip = findPassthroughClip({ tracks, mediaAssets, duration });
	if (!clip) return null;

	const input = new Input({
		source: createMediaSource({ file: clip.asset.file }),
		formats: ALL_FORMATS,
	});
	let passthrough: AudioPassthrough | null = null;
	try {
		const track = await input.getPrimaryAudioTrack();
		const codec = track?.codec;
		if (!track || !codec) return null;
		const supported = createOutputFormat({
			format,
			isStreamed: true,
		}).getSupportedAudioCodecs();
		if (!supported.includes(codec)) return null;
		const decoderConfig = await track.getDecoderConfig();
		if (!decoderConfig) return null;
		const stats = await track.computePacketStats(BITRATE_SAMPLE_PACKETS);

		const sink = new EncodedPacketSink(track);
		passthrough = {
			file: clip.asset.file,
			end: clip.end,
			track,
			codec,
			numberOfChannels: track.numberOfChannels,
			sampleRate: track.sampleRate,
			bitrate: stats.averageBitrate,
			decoderConfig,
			packets: async function* () {
				for await (const packet of sink.packets()) {
					// Through the packet the clip or the timeline ends in.
					if (packet.timestamp >= clip.end) break;
					// Before zero is the encoder's priming, which the source's edit
					// list hides and an export can't: left out, the sound stays in
					// time, its first milliseconds decoded a little differently.
					if (packet.timestamp >= 0) yield packet;
				}
			},
			close: () => input.dispose(),
		};
		return passthrough;
	} finally {
		if (!passthrough) input.dispose();
	}
}
