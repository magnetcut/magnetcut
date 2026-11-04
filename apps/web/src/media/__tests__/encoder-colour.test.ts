import { describe, expect, test } from "bun:test";
import { serializeAvcConfig } from "@/export/fast/h264";
import { correctEncodedColour, readStreamColour } from "../encoder-colour";

const hex = (text: string) =>
	new Uint8Array(text.match(/../g)?.map((pair) => parseInt(pair, 16)) ?? []);

// What WebKit's encoder made on macOS 27 (a 320×180 picture): an SPS with no
// VUI, so limited range, under a config that says full range and sRGB.
const description = serializeAvcConfig({
	config: {
		profile: 100,
		compatibility: 0,
		level: 20,
		lengthSize: 4,
		sps: [hex("276400144b15a0c378106114")],
		pps: [hex("284ae3cb")],
		extension: hex("fdf8f800"),
	},
});
const webkitClaim: VideoColorSpaceInit = {
	primaries: "bt709",
	transfer: "iec61966-2-1",
	matrix: "bt709",
	fullRange: true,
};

describe("the encoder's colour", () => {
	test("is read from the SPS: limited when it says nothing", () => {
		expect(
			readStreamColour({ config: { codec: "avc1.640014", description } }),
		).toEqual({
			primaries: null,
			transfer: null,
			matrix: null,
			fullRange: false,
		});
	});

	test("is put right when the config says full range and the stream doesn't", () => {
		expect(
			correctEncodedColour({
				config: { codec: "avc1.640014", description, colorSpace: webkitClaim },
			}),
		).toEqual({
			primaries: "bt709",
			transfer: "bt709",
			matrix: "bt709",
			fullRange: false,
		});
	});

	test("is left alone when the two agree, or there's no H.264 to read", () => {
		const limited = { ...webkitClaim, fullRange: false };
		expect(
			correctEncodedColour({
				config: { codec: "avc1.640014", description, colorSpace: limited },
			}),
		).toBeNull();
		expect(
			correctEncodedColour({
				config: {
					codec: "vp09.00.40.08",
					description,
					colorSpace: webkitClaim,
				},
			}),
		).toBeNull();
		expect(
			correctEncodedColour({
				config: {
					codec: "avc1.640014",
					description,
					colorSpace: { ...webkitClaim, fullRange: null },
				},
			}),
		).toBeNull();
	});
});
