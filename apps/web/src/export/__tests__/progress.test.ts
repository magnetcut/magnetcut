import { describe, expect, test } from "bun:test";
import {
	estimateSecondsLeft,
	formatDuration,
	formatExportPercent,
} from "../progress";

describe("an export's progress", () => {
	test("shows a decimal while it's under 10%", () => {
		expect(formatExportPercent({ progress: 0 })).toBe("0%");
		expect(formatExportPercent({ progress: 0.0036 })).toBe("0.3%");
		expect(formatExportPercent({ progress: 0.0999 })).toBe("9.9%");
		expect(formatExportPercent({ progress: 0.42 })).toBe("42%");
		// Never 100% before it's done.
		expect(formatExportPercent({ progress: 0.9999 })).toBe("99%");
		expect(formatExportPercent({ progress: 1 })).toBe("100%");
	});

	test("says how long", () => {
		expect(formatDuration({ seconds: 45.4 })).toBe("45 s");
		expect(formatDuration({ seconds: 200 })).toBe("3 min 20 s");
		expect(formatDuration({ seconds: 750 })).toBe("12 min");
		expect(formatDuration({ seconds: 7500 })).toBe("2 h 5 min");
	});

	test("has time left once there's enough to go on", () => {
		expect(
			estimateSecondsLeft({ progress: 0.0005, elapsedSeconds: 60 }),
		).toBeNull();
		expect(
			estimateSecondsLeft({ progress: 0.5, elapsedSeconds: 2 }),
		).toBeNull();
		// 2% in two minutes: 98 more of them.
		expect(estimateSecondsLeft({ progress: 0.02, elapsedSeconds: 120 })).toBe(
			5880,
		);
	});
});
