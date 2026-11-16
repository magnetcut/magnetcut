import { useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { useAppDialogsStore } from "../app-dialogs-store";
import { getCrashReportingStatus, setCrashReporting } from "../crash-reporting";

export function CrashReportingPrompt() {
	const [open, setOpen] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");
	const pending = useRef(false);
	const otherDialog = useAppDialogsStore((state) => state.openDialog);

	useEffect(() => {
		let cancelled = false;
		void getCrashReportingStatus()
			.then((status) => {
				if (!cancelled) setOpen(status.configured && !status.decided);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [otherDialog]);

	async function choose(enabled: boolean) {
		if (pending.current) return;
		pending.current = true;
		setSaving(true);
		setError("");
		try {
			const status = await setCrashReporting(enabled);
			setOpen(false);
			if (enabled && isTauri() && !status.active) {
				toast("Crash reporting will start next time you open MagnetCut.");
			}
		} catch {
			setError("Couldn’t save your choice. Please try again.");
		} finally {
			pending.current = false;
			setSaving(false);
		}
	}

	return (
		<Dialog
			open={open && otherDialog === null}
			onOpenChange={(value) => {
				if (!value) void choose(false);
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Help improve MagnetCut?</DialogTitle>
				</DialogHeader>
				<DialogBody>
					<DialogDescription>
						Send errors and crash diagnostics to Sentry to help us find and fix
						problems. Native crash reports may contain fragments of data in
						memory.
					</DialogDescription>
					<p className="text-muted-foreground text-sm">
						This is optional. You can change your choice anytime in Settings →
						Send crash reports.
					</p>
					{isTauri() && (
						<p className="text-muted-foreground text-sm">
							Reporting starts the next time you open MagnetCut.
						</p>
					)}
					{error && (
						<p role="alert" className="text-destructive text-sm">
							{error}
						</p>
					)}
				</DialogBody>
				<DialogFooter>
					<Button
						variant="outline"
						disabled={saving}
						onClick={() => void choose(false)}
					>
						No thanks
					</Button>
					<Button disabled={saving} onClick={() => void choose(true)}>
						Send crash reports
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
