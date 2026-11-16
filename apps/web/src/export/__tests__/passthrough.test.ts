import { describe, expect, test } from "bun:test";
import { ADTS, MATROSKA, MP4, MPEG_TS, QTFF, WEBM } from "mediabunny";
import { isNativeCopyFormat } from "../passthrough";

describe("the desktop app's own export copies sound", () => {
	test("from MP4 and QuickTime files", () => {
		expect(isNativeCopyFormat({ format: MP4 })).toBe(true);
		expect(isNativeCopyFormat({ format: QTFF })).toBe(true);
	});

	test("from no other: the web view's export copies it", () => {
		for (const format of [MATROSKA, WEBM, MPEG_TS, ADTS]) {
			expect(isNativeCopyFormat({ format })).toBe(false);
		}
	});
});
