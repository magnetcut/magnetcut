// How far an export has got, as the export panel says it: a long one (AV1 in
// software takes hours) moves a whole percent only every few minutes, so it
// shows a decimal while it's under 10%, how long it's taken and how long it
// has left at that pace.

/** A progress from 0 to 1 as a percentage: one decimal under 10%. */
export function formatExportPercent({
	progress,
}: {
	progress: number;
}): string {
	const percent = Math.min(Math.max(progress, 0), 1) * 100;
	if (percent < 10) return `${Math.floor(percent * 10) / 10}%`;
	return `${Math.floor(percent)}%`;
}

/** Seconds as the panel says them: "45 s", "3 min 20 s", "12 min", "2 h 5 min". */
export function formatDuration({ seconds }: { seconds: number }): string {
	const whole = Math.max(0, Math.round(seconds));
	if (whole < 60) return `${whole} s`;
	const minutes = Math.floor(whole / 60);
	if (whole < 600) return `${minutes} min ${whole % 60} s`;
	if (whole < 3600) return `${minutes} min`;
	return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** Seconds left at the pace so far: none until there's enough to go on. */
export function estimateSecondsLeft({
	progress,
	elapsedSeconds,
}: {
	progress: number;
	elapsedSeconds: number;
}): number | null {
	if (progress <= 0.001 || progress >= 1 || elapsedSeconds < 5) return null;
	return (elapsedSeconds * (1 - progress)) / progress;
}
