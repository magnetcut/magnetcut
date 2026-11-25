import { describe, expect, test } from "bun:test";
import { fillFromClips, fromMetadataTags, suggestFileTags } from "../clip-tags";

describe("what the clips say of themselves", () => {
	test("an iPhone's clip: the day as filmed, where, and the camera", () => {
		expect(
			fromMetadataTags({
				tags: {
					// Just after midnight there, the day before in UTC.
					date: new Date("2026-11-13T00:31:42+0100"),
					raw: {
						"com.apple.quicktime.creationdate": "2026-11-13T00:31:42+0100",
						"com.apple.quicktime.location.ISO6709":
							"+48.8584+002.2945+035.000/",
						"com.apple.quicktime.make": "Apple",
						"com.apple.quicktime.model": "iPhone 17 Pro",
						"com.apple.quicktime.software": "27.2",
					},
				},
			}),
		).toEqual({
			date: "2026-11-13",
			location: "+48.8584+002.2945+035.000/",
			make: "Apple",
			model: "iPhone 17 Pro",
		});
	});

	test("the day as filmed west of UTC, where UTC's is the next", () => {
		expect(
			fromMetadataTags({
				tags: {
					date: new Date("2026-11-13T20:00:00-0800"),
					raw: {
						"com.apple.quicktime.creationdate": "2026-11-13T20:00:00-0800",
					},
				},
			}),
		).toEqual({ date: "2026-11-13" });
	});

	test("Matroska's tags, in capitals; and no day from a year alone", () => {
		expect(
			fromMetadataTags({ tags: { raw: { DATE: "2026-11-13", MAKE: "Sony" } } }),
		).toEqual({ date: "2026-11-13", make: "Sony" });
		expect(fromMetadataTags({ tags: { raw: { "©day": "2026" } } })).toEqual({});
	});

	test("an Android phone's place, and a title", () => {
		expect(
			fromMetadataTags({
				tags: { title: "Beach", raw: { "©xyz": "-33.8568+151.2153/" } },
			}),
		).toEqual({ title: "Beach", location: "-33.8568+151.2153/" });
	});

	test("each value once, the dates earliest first, a few", () => {
		const suggestions = suggestFileTags({
			clips: [
				{
					name: "b.mov",
					tags: { date: "2026-11-14", make: "Apple", model: "iPhone 17 Pro" },
				},
				{
					name: "a.mov",
					tags: { date: "2026-11-13", make: "Apple", model: "iPhone 17 Pro" },
				},
				{ name: "c.mp4", tags: { date: "2026-11-15" } },
				{ name: "d.mp4", tags: { date: "2026-11-12" } },
			],
		});
		expect(suggestions.date?.map(({ value }) => value)).toEqual([
			"2026-11-12",
			"2026-11-13",
			"2026-11-14",
		]);
		expect(suggestions.model).toEqual([
			{ value: "iPhone 17 Pro", make: "Apple", clip: "b.mov" },
		]);
	});

	test("filling in from them leaves what's written, and the place out", () => {
		const suggestions = suggestFileTags({
			clips: [
				{
					name: "a.mov",
					tags: {
						title: "Clip",
						date: "2026-11-13",
						location: "+48.8584+002.2945/",
						make: "Apple",
						model: "iPhone 17 Pro",
					},
				},
			],
		});
		expect(fillFromClips({ tags: { title: "My film" }, suggestions })).toEqual({
			title: "My film",
			date: "2026-11-13",
			make: "Apple",
			model: "iPhone 17 Pro",
		});
	});
});
