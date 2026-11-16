import { useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
	getCrashReportingStatus,
	setCrashReporting,
	type CrashReportingStatus,
} from "../crash-reporting";

export function CrashReportingSetting() {
	const [status, setStatus] = useState<CrashReportingStatus | null>(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");
	useEffect(() => {
		void getCrashReportingStatus()
			.then(setStatus)
			.catch(() => setError("Couldn’t read crash reporting settings."));
	}, []);
	return (
		<section className="flex flex-col gap-2">
			<div className="flex items-start justify-between gap-4">
				<div className="flex flex-col gap-1">
					<Label htmlFor="crash-reporting">Send crash reports</Label>
					<p className="text-muted-foreground text-xs">
						Send errors and crash diagnostics to Sentry to help fix MagnetCut.
						Native crash reports may contain fragments of data in memory.
					</p>
				</div>
				<Switch
					id="crash-reporting"
					checked={status?.enabled ?? false}
					disabled={!status?.configured || saving}
					onCheckedChange={async (value) => {
						setSaving(true);
						setError("");
						try {
							setStatus(await setCrashReporting(value));
						} catch {
							setError("Couldn’t save crash reporting settings.");
						} finally {
							setSaving(false);
						}
					}}
				/>
			</div>
			{status && !status.configured && (
				<p className="text-muted-foreground text-xs">
					Crash reporting isn’t available in this build.
				</p>
			)}
			{status?.enabled && status.configured && !status.active && (
				<p className="text-muted-foreground text-xs">
					Restart MagnetCut to start crash reporting.
				</p>
			)}
			{error && (
				<p role="alert" className="text-destructive text-xs">
					{error}
				</p>
			)}
		</section>
	);
}
