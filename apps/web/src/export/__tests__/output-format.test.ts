import { describe, expect, test } from "bun:test";
import {
	ALL_FORMATS,
	BufferSource,
	BufferTarget,
	EncodedAudioPacketSource,
	EncodedPacket,
	Input,
	Output,
} from "mediabunny";
import type { ExportFormat } from "@/export";
import { createOutputFormat, getWritingAppTags } from "../output-format";

const WRITING_APP = "MagnetCut 1.2.3";

/** A file of a few milliseconds of sound, written as an export writes one. */
async function write({
	format,
}: {
	format: ExportFormat;
}): Promise<Uint8Array> {
	const target = new BufferTarget();
	const output = new Output({
		format: createOutputFormat({
			format,
			isStreamed: false,
			writingApp: WRITING_APP,
		}),
		target,
	});
	output.setMetadataTags(
		getWritingAppTags({ format, writingApp: WRITING_APP }),
	);
	const codec = format === "webm" ? "opus" : "pcm-s16";
	const source = new EncodedAudioPacketSource(codec);
	output.addAudioTrack(source);
	await output.start();
	await source.add(new EncodedPacket(new Uint8Array(480), "key", 0, 0.005), {
		decoderConfig: { codec, numberOfChannels: 2, sampleRate: 48000 },
	});
	await output.finalize();
	if (!target.buffer) throw new Error("nothing written");
	return new Uint8Array(target.buffer);
}

/** Whether `data` has these bytes somewhere. */
function includes({
	data,
	bytes,
}: {
	data: Uint8Array;
	bytes: Uint8Array;
}): boolean {
	for (let at = 0; at + bytes.length <= data.length; at++) {
		if (bytes.every((byte, i) => data[at + i] === byte)) return true;
	}
	return false;
}

const FIELDS: Record<ExportFormat, string> = {
	mp4: "©too",
	mov: "©swr",
	mkv: "ENCODER",
	webm: "ENCODER",
};

describe("the program that wrote an export", () => {
	for (const format of ["mp4", "mov", "mkv", "webm"] as const) {
		test(`is in a ${format} file's own field`, async () => {
			const data = await write({ format });
			const input = new Input({
				source: new BufferSource(data),
				formats: ALL_FORMATS,
			});
			const tags = await input.getMetadataTags();
			expect(tags.raw?.[FIELDS[format]]).toBe(WRITING_APP);
		});
	}

	test("is Matroska's WritingApp, mediabunny staying its MuxingApp", async () => {
		const data = await write({ format: "mkv" });
		const name = new TextEncoder().encode(WRITING_APP);
		// The element's id, its size (one byte), then the name.
		const writingApp = new Uint8Array([
			0x57,
			0x41,
			0x80 | name.length,
			...name,
		]);
		expect(includes({ data, bytes: writingApp })).toBe(true);
		const library = new TextEncoder().encode("Mediabunny");
		const muxingApp = new Uint8Array([
			0x4d,
			0x80,
			0x80 | library.length,
			...library,
		]);
		expect(includes({ data, bytes: muxingApp })).toBe(true);
	});
});
