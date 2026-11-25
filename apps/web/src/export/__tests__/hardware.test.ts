import { describe, expect, test } from "bun:test";
import { DEFAULT_WIZARD_ANSWERS, applyWizardAnswers } from "../wizard";
import { DEFAULT_EXPORT_CHOICES } from "../choices";
import type { NativeCapabilities } from "../native";
import type { ExportVideoCodec } from "../settings";
import {
	canKeepToHardware,
	firstHardwareCodec,
	getCodecAvailability,
	getEncoderSpeed,
	getHardwareCodecs,
	getSoftwareCodecs,
	isOffered,
	keepToHardware,
	useHardwareOnlyStore,
} from "../hardware";

// A Mac's: H.264, HEVC and ProRes in hardware, AV1 in software.
const mac: NativeCapabilities = {
	formats: ["mp4", "mov"],
	videoCodecs: ["avc", "hevc", "prores", "prores-hq", "av1"],
	hardwareCodecs: ["avc", "hevc", "prores", "prores-hq"],
	constantQuality: true,
	audioCopy: true,
	subtitleTracks: true,
	priority: true,
};
const encodable = new Set<ExportVideoCodec>(mac.videoCodecs);

function smallest({ offered }: { offered: Set<ExportVideoCodec> | null }) {
	return applyWizardAnswers({
		answers: { ...DEFAULT_WIZARD_ANSWERS, destination: "small" },
		choices: DEFAULT_EXPORT_CHOICES,
		encodable: offered,
		picture: { width: 3840, height: 2160 },
		projectFps: 30,
		duration: 60,
		copiedBitrate: null,
	}).videoCodec;
}

describe("keeping to hardware", () => {
	test("the smallest file is HEVC on a Mac, AV1 once software's allowed", () => {
		const hardware = getHardwareCodecs({ native: mac, format: "mp4" });
		expect(
			smallest({
				offered: keepToHardware({ encodable, hardware, hardwareOnly: true }),
			}),
		).toBe("hevc");
		expect(
			smallest({
				offered: keepToHardware({ encodable, hardware, hardwareOnly: false }),
			}),
		).toBe("av1");
	});

	test("changes nothing where nothing is known to be in hardware", () => {
		// A browser: nothing known.
		expect(
			keepToHardware({ encodable, hardware: null, hardwareOnly: true }),
		).toBe(encodable);
		// A computer whose encoders are all software: nothing to keep to.
		const none = getHardwareCodecs({
			native: { ...mac, hardwareCodecs: [] },
			format: "mp4",
		});
		expect(canKeepToHardware(none)).toBe(false);
		expect(
			keepToHardware({ encodable, hardware: none, hardwareOnly: true }),
		).toBe(encodable);
	});

	test("nothing's known of a format the app's own export doesn't make", () => {
		// WebM is the web view's encoders', whichever they are: kept to
		// nothing, and of no known speed.
		const hardware = getHardwareCodecs({ native: mac, format: "webm" });
		expect(hardware).toBeNull();
		expect(getEncoderSpeed({ codec: "vp9", hardware })).toBeNull();
		expect(
			getCodecAvailability({
				codec: "vp9",
				encodable: new Set(["vp9", "av1"]),
				hardware,
				hardwareOnly: true,
			}),
		).toBe("available");
		expect(
			getSoftwareCodecs({ format: "webm", encodable: encodable, hardware }),
		).toEqual([]);
	});

	test("is on until it's turned off", () => {
		expect(useHardwareOnlyStore.getState().hardwareOnly).toBe(true);
		useHardwareOnlyStore.getState().setHardwareOnly({ hardwareOnly: false });
		expect(useHardwareOnlyStore.getState().hardwareOnly).toBe(false);
		useHardwareOnlyStore.getState().setHardwareOnly({ hardwareOnly: true });
	});
});

describe("how a codec is to be had", () => {
	const hardware = getHardwareCodecs({ native: mac, format: "mp4" });
	const availability = ({
		codec,
		hardwareOnly = true,
		of = encodable,
	}: {
		codec: ExportVideoCodec;
		hardwareOnly?: boolean;
		of?: Set<ExportVideoCodec> | null;
	}) => getCodecAvailability({ codec, encodable: of, hardware, hardwareOnly });

	test("in hardware, in software, left out, or not at all", () => {
		expect(availability({ codec: "hevc" })).toBe("available");
		expect(availability({ codec: "av1" })).toBe("left-out");
		expect(availability({ codec: "av1", hardwareOnly: false })).toBe(
			"software",
		);
		expect(availability({ codec: "vp9" })).toBe("unavailable");
		// While what's encoded isn't known, it's offered.
		expect(availability({ codec: "av1", of: null })).toBe("available");
	});

	test("offered where it's encoded and not left out", () => {
		expect(isOffered({ availability: "available" })).toBe(true);
		expect(isOffered({ availability: "software" })).toBe(true);
		expect(isOffered({ availability: "left-out" })).toBe(false);
		expect(isOffered({ availability: "unavailable" })).toBe(false);
	});

	test("the format's codecs in software, and the first in hardware", () => {
		expect(getSoftwareCodecs({ format: "mp4", encodable, hardware })).toEqual([
			"av1",
		]);
		expect(getSoftwareCodecs({ format: "mov", encodable, hardware })).toEqual(
			[],
		);
		expect(firstHardwareCodec({ format: "mp4", encodable, hardware })).toBe(
			"avc",
		);
		expect(
			firstHardwareCodec({
				format: "mp4",
				encodable: new Set(["hevc", "av1"]),
				hardware,
			}),
		).toBe("hevc");
		expect(getEncoderSpeed({ codec: "hevc", hardware })).toBe("hardware");
		expect(getEncoderSpeed({ codec: "av1", hardware })).toBe("software");
	});
});
