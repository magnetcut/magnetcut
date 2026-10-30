import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ALL_FORMATS, Input } from "mediabunny";
import {
	createMediaSource,
	DiskFile,
	findDroppedDiskFiles,
} from "../disk-file";

// One second of silence as 16-bit mono WAV at 8 kHz.
function makeWav() {
	const sampleRate = 8000;
	const data = sampleRate * 2;
	const bytes = new Uint8Array(44 + data);
	const view = new DataView(bytes.buffer);
	const ascii = ({ offset, text }: { offset: number; text: string }) => {
		for (let i = 0; i < text.length; i++)
			bytes[offset + i] = text.charCodeAt(i);
	};
	ascii({ offset: 0, text: "RIFF" });
	view.setUint32(4, 36 + data, true);
	ascii({ offset: 8, text: "WAVEfmt " });
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	ascii({ offset: 36, text: "data" });
	view.setUint32(40, data, true);
	return bytes;
}

const wav = makeWav();
const reads: { start: number; end: number }[] = [];
// What the desktop app would answer (apps/desktop/src/media.rs).
const files = new Map([["/media/silence.wav", wav]]);
let dropped: { path: string; name: string; size: number }[] = [];

function fakeInvoke({
	command,
	args,
}: {
	command: string;
	args: Record<string, unknown>;
}) {
	if (command === "read_media_file") {
		const start = Number(args.start);
		const end = Number(args.end);
		reads.push({ start, end });
		const bytes = files.get(String(args.path));
		if (!bytes) throw new Error("not a file MagnetCut was given");
		return bytes.slice(start, end).buffer;
	}
	if (command === "dropped_media_files") {
		return dropped.map((file) => ({ ...file, lastModified: 0 }));
	}
	throw new Error(`unexpected command ${command}`);
}

const globals = globalThis as Record<string, unknown>;
beforeAll(() => {
	globals.window ??= globalThis;
	globals.isTauri = true;
	globals.__TAURI_INTERNALS__ = {
		// eslint-disable-next-line magnetcut/prefer-object-params -- Tauri's own signature.
		invoke: (command: string, args: Record<string, unknown>) =>
			Promise.resolve().then(() => fakeInvoke({ command, args })),
	};
});
afterAll(() => {
	delete globals.isTauri;
	delete globals.__TAURI_INTERNALS__;
});

const silence = () =>
	new DiskFile({
		path: "/media/silence.wav",
		name: "silence.wav",
		size: wav.length,
		lastModified: 0,
	});

describe("a file read where it is", () => {
	test("has the type its extension says", () => {
		expect(silence().type).toBe("audio/wav");
	});

	test("reads all its bytes", async () => {
		const bytes = new Uint8Array(await silence().arrayBuffer());
		expect(bytes).toEqual(wav);
	});

	test("is decoded by the piece", async () => {
		reads.length = 0;
		const input = new Input({
			source: createMediaSource({ file: silence() }),
			formats: ALL_FORMATS,
		});
		try {
			expect(await input.computeDuration()).toBeCloseTo(1, 3);
		} finally {
			input.dispose();
		}
		expect(reads.length).toBeGreaterThan(0);
		for (const { start, end } of reads) {
			expect(end).toBeGreaterThan(start);
			expect(end).toBeLessThanOrEqual(wav.length);
		}
	});
});

describe("dropped files", () => {
	const file = ({ name, size }: { name: string; size: number }) =>
		new File([new Uint8Array(size)], name);

	test("are found on disk by name and size", async () => {
		dropped = [{ path: "/media/a.mp4", name: "a.mp4", size: 3 }];
		const [found, other] = await findDroppedDiskFiles({
			files: [
				file({ name: "a.mp4", size: 3 }),
				file({ name: "b.mp4", size: 3 }),
			],
		});
		expect(found).toBeInstanceOf(DiskFile);
		expect(found instanceof DiskFile && found.path).toBe("/media/a.mp4");
		expect(other).toBeInstanceOf(File);
	});

	test("stay as they are when the sizes differ", async () => {
		dropped = [{ path: "/media/a.mp4", name: "a.mp4", size: 4 }];
		const [kept] = await findDroppedDiskFiles({
			files: [file({ name: "a.mp4", size: 3 })],
		});
		expect(kept).toBeInstanceOf(File);
	});
});
