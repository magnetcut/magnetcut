import { TICKS_PER_SECOND } from "@/wasm";

// Times as agents write them and read them (docs/AUTOMATION.md): seconds
// (12.5), minutes and seconds (1:02.5) or a frame (f123), and back as m:ss.s.

/** A time an agent wrote, in ticks; null if it isn't one. */
export function parseTime({
	value,
	fps,
}: {
	value: unknown;
	fps: number;
}): number | null {
	if (typeof value === "number") {
		return Number.isFinite(value) && value >= 0
			? Math.round(value * TICKS_PER_SECOND)
			: null;
	}
	if (typeof value !== "string") return null;
	const text = value.trim();
	const frame = /^f(\d+)$/.exec(text);
	if (frame) return Math.round((Number(frame[1]) / fps) * TICKS_PER_SECOND);
	const clock = /^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text);
	if (clock) {
		const [, hours, minutes, seconds] = clock;
		const total =
			Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds);
		return Math.round(total * TICKS_PER_SECOND);
	}
	if (/^\d+(?:\.\d+)?s?$/.test(text)) {
		return Math.round(Number.parseFloat(text) * TICKS_PER_SECOND);
	}
	return null;
}

/** A time to read: m:ss.s (h:mm:ss.s past an hour). */
export function formatTime({ ticks }: { ticks: number }): string {
	const tenths = Math.round((ticks / TICKS_PER_SECOND) * 10);
	const seconds = (tenths % 600) / 10;
	const minutes = Math.floor(tenths / 600) % 60;
	const hours = Math.floor(tenths / 36000);
	const ss = seconds.toFixed(1).padStart(4, "0");
	return hours > 0
		? `${hours}:${String(minutes).padStart(2, "0")}:${ss}`
		: `${minutes}:${ss}`;
}
