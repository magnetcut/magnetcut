import { useState } from "react";
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
import { Progress } from "@/components/ui/progress";
import { useAppDialogsStore } from "../app-dialogs-store";
import { useSettingsStore } from "../settings-store";
import {
	type DownloadProgress,
	describeError,
	installUpdate,
} from "../updates";

function formatMegabytes({ bytes }: { bytes: number }): string {
	const megabytes = bytes / 1e6;
	return `${megabytes < 10 ? megabytes.toFixed(1) : Math.round(megabytes)} MB`;
}

/** A newer version, with its notes: install it now, later, or never. */
export function UpdateDialog() {
	const update = useAppDialogsStore((state) => state.update);
	const setUpdate = useAppDialogsStore((state) => state.setUpdate);
	const setSkippedVersion = useSettingsStore(
		(state) => state.setSkippedVersion,
	);
	const [isInstalling, setIsInstalling] = useState(false);
	const [progress, setProgress] = useState<DownloadProgress | null>(null);

	if (!update) return null;

	const dismiss = () => {
		if (isInstalling) return;
		setUpdate({ update: null });
		void update.close();
	};

	const install = async () => {
		setIsInstalling(true);
		try {
			await installUpdate({ update, onProgress: setProgress });
		} catch (error) {
			toast.error("The update didn't install", {
				description: describeError(error),
			});
			setIsInstalling(false);
			setProgress(null);
		}
	};

	const isDownloaded =
		progress?.total != null && progress.downloaded >= progress.total;
	const status = !progress
		? "Starting the download…"
		: isDownloaded
			? "Installing…"
			: `Downloading… ${formatMegabytes({ bytes: progress.downloaded })}${
					progress.total
						? ` of ${formatMegabytes({ bytes: progress.total })}`
						: ""
				}`;

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) dismiss();
			}}
		>
			<DialogContent onOpenAutoFocus={(event) => event.preventDefault()}>
				<DialogHeader>
					<DialogTitle>MagnetCut {update.version} is available</DialogTitle>
					<DialogDescription>
						You have {update.currentVersion}. Installing it saves your project
						and restarts MagnetCut.
					</DialogDescription>
				</DialogHeader>
				{(update.body || isInstalling) && (
					<DialogBody>
						{update.body && (
							<div className="max-h-64 overflow-y-auto text-sm whitespace-pre-wrap">
								{update.body}
							</div>
						)}
						{isInstalling && (
							<div className="flex flex-col gap-2">
								<Progress
									value={
										progress?.total
											? (progress.downloaded / progress.total) * 100
											: 0
									}
								/>
								<p className="text-muted-foreground text-xs">{status}</p>
							</div>
						)}
					</DialogBody>
				)}
				<DialogFooter>
					<Button
						variant="ghost"
						className="sm:mr-auto"
						disabled={isInstalling}
						onClick={() => {
							setSkippedVersion({ version: update.version });
							dismiss();
						}}
					>
						Skip This Version
					</Button>
					<Button variant="outline" disabled={isInstalling} onClick={dismiss}>
						Later
					</Button>
					<Button disabled={isInstalling} onClick={() => void install()}>
						{isInstalling ? "Installing…" : "Install and Restart"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
