import { describe, expect, test } from "bun:test";
import {
	MAX_FILE_TAG_LENGTH,
	formatCamera,
	formatPlace,
	getDateTime,
	hasFileTags,
	isDay,
	normalizeFileTags,
	parsePlace,
} from "../file-tags";

describe("a project's details", () => {
	test("trimmed, and none that's empty, malformed or not text", () => {
		expect(
			normalizeFileTags({
				raw: {
					title: "  A walk ",
					artist: "",
					genre: 3,
					date: "13/11/2026",
					location: "somewhere",
					make: "Apple",
					other: "kept out",
				},
			}),
		).toEqual({ title: "A walk", make: "Apple" });
		expect(normalizeFileTags({ raw: null })).toEqual({});
		expect(hasFileTags({ tags: {} })).toBe(false);
		expect(hasFileTags({ tags: { comment: "x" } })).toBe(true);
	});

	test("no control characters, and a description's lines kept", () => {
		expect(
			normalizeFileTags({
				raw: {
					title: "A\u0000 walk\tthere\nnow\u0007",
					description: "Line one\r\nLine two\rthree\tfour\u001b",
				},
			}),
		).toEqual({
			title: "A walk there now",
			description: "Line one\nLine two\nthree four",
		});
	});

	test("at most so long, in characters, not UTF-16's halves", () => {
		const { title, comment } = normalizeFileTags({
			raw: {
				title: "😀".repeat(MAX_FILE_TAG_LENGTH + 1),
				// What's cut short ends in no space.
				comment: `${"a".repeat(MAX_FILE_TAG_LENGTH - 1)} b`,
			},
		});
		expect(Array.from(title ?? "")).toHaveLength(MAX_FILE_TAG_LENGTH);
		expect(comment).toBe("a".repeat(MAX_FILE_TAG_LENGTH - 1));
	});

	test("a date that's a day of the calendar, written at noon in UTC", () => {
		expect(isDay({ day: "2028-02-29" })).toBe(true);
		expect(isDay({ day: "2026-02-29" })).toBe(false);
		expect(isDay({ day: "2026-02-30" })).toBe(false);
		expect(isDay({ day: "2026-13-01" })).toBe(false);
		expect(isDay({ day: "2026-1-1" })).toBe(false);
		// A year under 100 is that year, not one in the 1900s.
		expect(isDay({ day: "0099-02-29" })).toBe(false);
		expect(isDay({ day: "0096-02-29" })).toBe(true);
		expect(normalizeFileTags({ raw: { date: "2026-02-30" } })).toEqual({});
		expect(getDateTime({ day: "2026-11-13" })).toBe("2026-11-13T12:00:00Z");
	});

	test("a place in ISO 6709, as people read it", () => {
		expect(parsePlace({ location: "+48.8584+002.2945+035.000/" })).toEqual({
			latitude: 48.8584,
			longitude: 2.2945,
			height: 35,
		});
		expect(parsePlace({ location: "-33.8568+151.2153/" })).toEqual({
			latitude: -33.8568,
			longitude: 151.2153,
		});
		expect(parsePlace({ location: "+91.0+000.0/" })).toBeNull();
		expect(formatPlace({ location: "-33.8568+151.2153/" })).toBe(
			"33.8568° S, 151.2153° E",
		);
		expect(formatPlace({ location: "+40.6892-074.0445/" })).toBe(
			"40.6892° N, 74.0445° W",
		);
	});

	test("the camera as one line, its maker once", () => {
		expect(formatCamera({ make: "Apple", model: "iPhone 17 Pro" })).toBe(
			"Apple iPhone 17 Pro",
		);
		expect(formatCamera({ make: "Canon", model: "Canon EOS R5" })).toBe(
			"Canon EOS R5",
		);
		expect(formatCamera({ model: "GoPro HERO13" })).toBe("GoPro HERO13");
		expect(formatCamera({})).toBe("");
	});
});
