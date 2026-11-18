import { useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

type GpuAccelerationStatus = {
	/** Only on Linux: elsewhere the GPU is always used. */
	supported: boolean;
	/** The choice saved, for the next launch. */
	enabled: boolean;
	/** This run's. */
	active: boolean;
};

/** Hardware video decoding and GPU-drawn canvases on Linux (graphics.rs). */
export function GpuAccelerationSetting() {
	const [status, setStatus] = useState<GpuAccelerationStatus | null>(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");
	useEffect(() => {
		if (!isTauri()) return;
		void invoke<GpuAccelerationStatus>("gpu_acceleration_status")
			.then(setStatus)
			.catch(() => {});
	}, []);
	if (!status?.supported) return null;
	return (
		<section className="flex flex-col gap-2">
			<div className="flex items-start justify-between gap-4">
				<div className="flex flex-col gap-1">
					<Label htmlFor="gpu-acceleration">GPU acceleration</Label>
					<p className="text-muted-foreground text-xs">
						Decode and draw video on the graphics card.
					</p>
				</div>
				<Switch
					id="gpu-acceleration"
					checked={status.enabled}
					disabled={saving}
					onCheckedChange={async (value) => {
						setSaving(true);
						setError("");
						try {
							setStatus(
								await invoke<GpuAccelerationStatus>("set_gpu_acceleration", {
									enabled: value,
								}),
							);
						} catch {
							setError("Couldn’t save the GPU acceleration setting.");
						} finally {
							setSaving(false);
						}
					}}
				/>
			</div>
			<p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-700 dark:text-amber-300">
				Unstable on older Linux distributions: MagnetCut can crash while video
				plays. Turn it off if that happens.
			</p>
			{status.enabled !== status.active && (
				<p className="text-muted-foreground text-xs">
					Restart MagnetCut to apply.
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
