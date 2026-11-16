import { describe, expect, test } from "bun:test";
import { type RecordingSink, TakeWriter } from "../recorder";
import { WAV_HEADER_BYTES } from "../wav";

// Two bytes a sample, mono: a block of five samples is ten bytes.
const BLOCK = new Float32Array([0, 0.25, 0.5, -0.25, -0.5]);
const BLOCK_BYTES = BLOCK.length * 2;

/**
 * A file in memory whose writes of sound fail from the `failFrom`th on, as a
 * disk that's full does; writing the header over what's there still works.
 */
function makeSink({ failFrom }: { failFrom?: number }) {
	let file = new Uint8Array(0);
	let soundWrites = 0;
	const state = { kept: false, discarded: false };
	const sink: RecordingSink = {
		write: async ({ bytes, position }) => {
			if (position >= WAV_HEADER_BYTES) {
				soundWrites += 1;
				if (failFrom !== undefined && soundWrites >= failFrom) {
					throw new Error("No space left on device");
				}
			}
			if (position + bytes.length > file.length) {
				const grown = new Uint8Array(position + bytes.length);
				grown.set(file);
				file = grown;
			}
			file.set(bytes, position);
		},
		finish: async () => {
			state.kept = true;
			return new File([file], "take.wav", { type: "audio/wav" });
		},
		discard: async () => {
			state.discarded = true;
		},
	};
	return { sink, state, getBytes: () => file };
}

/** The sizes a WAV header gives: of the RIFF chunk, and of its sound. */
function readSizes({ bytes }: { bytes: Uint8Array }) {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
	return { riff: view.getUint32(4, true), data: view.getUint32(40, true) };
}

describe("a take as it's written", () => {
	test("finished, its header says how much sound it has", async () => {
		const { sink, state, getBytes } = makeSink({});
		const take = new TakeWriter({ sink, sampleRate: 48000 });
		for (let i = 0; i < 3; i++) take.add({ samples: BLOCK });
		const { file, error } = await take.finish();
		expect(error).toBeNull();
		expect(state).toEqual({ kept: true, discarded: false });
		expect(file.size).toBe(WAV_HEADER_BYTES + 3 * BLOCK_BYTES);
		expect(readSizes({ bytes: getBytes() })).toEqual({
			riff: 36 + 3 * BLOCK_BYTES,
			data: 3 * BLOCK_BYTES,
		});
	});

	test("a write that fails keeps what was written before it", async () => {
		const { sink, state, getBytes } = makeSink({ failFrom: 3 });
		const failures: unknown[] = [];
		const take = new TakeWriter({
			sink,
			sampleRate: 48000,
			onFailure: (error) => failures.push(error),
		});
		for (let i = 0; i < 5; i++) take.add({ samples: BLOCK });
		// The writes done, the take still recording: nothing more is written.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(failures).toHaveLength(1);
		take.add({ samples: BLOCK });
		const { error } = await take.finish();
		expect(String(error)).toContain("No space left on device");
		expect(failures).toHaveLength(1);
		expect(state).toEqual({ kept: true, discarded: false });
		expect(readSizes({ bytes: getBytes() }).data).toBe(2 * BLOCK_BYTES);
		expect(getBytes().length).toBe(WAV_HEADER_BYTES + 2 * BLOCK_BYTES);
	});

	test("with no sound written, there's nothing to keep", async () => {
		const { sink, state } = makeSink({ failFrom: 1 });
		const take = new TakeWriter({ sink, sampleRate: 48000 });
		take.add({ samples: BLOCK });
		await expect(take.finish()).rejects.toThrow("No space left on device");
		expect(state).toEqual({ kept: false, discarded: true });
	});

	test("the header is brought up to date each second", async () => {
		const { sink, getBytes } = makeSink({});
		// Five samples a second: each block is a second.
		const take = new TakeWriter({ sink, sampleRate: BLOCK.length });
		take.add({ samples: BLOCK });
		take.add({ samples: BLOCK });
		await take.discard().catch(() => undefined);
		expect(readSizes({ bytes: getBytes() }).data).toBe(2 * BLOCK_BYTES);
	});
});
