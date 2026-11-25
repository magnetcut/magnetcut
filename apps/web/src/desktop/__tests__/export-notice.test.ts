import { describe, expect, test } from "bun:test";
import { describeExportEnd } from "../export-notice";

describe("the notification at an export's end", () => {
	test("names the file and how long it took", () => {
		expect(
			describeExportEnd({
				result: { success: true, path: "/Users/someone/Downloads/Film.mp4" },
				name: "Film",
				seconds: 552,
			}),
		).toEqual({
			title: "Export finished",
			body: "Film.mp4, made in 9 min 12 s",
		});
		expect(
			describeExportEnd({
				result: { success: true, path: "C:\\Users\\someone\\Film.mov" },
				name: "Film",
				seconds: 40,
			})?.body,
		).toBe("Film.mov, made in 40 s");
	});

	test("the project's name for a download", () => {
		expect(
			describeExportEnd({
				result: { success: true, buffer: new ArrayBuffer(1) },
				name: "Film",
				seconds: 5,
			})?.body,
		).toBe("Film, made in 5 s");
	});

	test("why it failed, shortened", () => {
		const notice = describeExportEnd({
			result: { success: false, error: "x".repeat(400) },
			name: "Film",
			seconds: 5,
		});
		expect(notice?.title).toBe("Export failed");
		expect(notice?.body.length).toBeLessThan(200);
		expect(notice?.body.endsWith("…")).toBe(true);
	});

	test("nothing for a cancelled export", () => {
		expect(
			describeExportEnd({
				result: { success: false, cancelled: true },
				name: "Film",
				seconds: 5,
			}),
		).toBeNull();
	});
});
