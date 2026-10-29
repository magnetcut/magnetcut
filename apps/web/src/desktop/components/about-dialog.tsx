import Image from "next/image";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useAppDialogsStore } from "../app-dialogs-store";
import { useAppInfo } from "../app-info";
import { useSettingsStore } from "../settings-store";
import { checkForUpdatesNow } from "../updates";

export const SOURCE_URL = "https://github.com/magnetcut/magnetcut";
const OPENCUT_URL = "https://github.com/OpenCut-app/opencut-classic";

export function AboutDialog({
	isOpen,
	onOpenChange,
}: {
	isOpen: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const info = useAppInfo();
	const storage = useStorageEstimate({ isOpen });

	return (
		<Dialog open={isOpen} onOpenChange={onOpenChange}>
			<DialogContent
				className="max-w-md"
				onOpenAutoFocus={(event) => event.preventDefault()}
			>
				<div className="flex flex-col items-center gap-3 px-8 pt-9 pb-7 text-center">
					<Image
						src="/logos/magnetcut/icon.svg"
						alt=""
						width={96}
						height={96}
						className="size-24"
					/>
					<DialogTitle className="text-2xl font-bold">MagnetCut</DialogTitle>
					{info && (
						<p className="text-muted-foreground text-sm">
							Version {info.version}
						</p>
					)}
					{info?.updates && <UpdateLine />}
					<p className="text-muted-foreground text-sm">
						A video editor that keeps everything on your computer.
					</p>
					{storage && (
						<p className="bg-muted/50 text-muted-foreground w-full rounded-md border px-4 py-3 text-xs">
							Your projects and media take{" "}
							{formatStorage({ bytes: storage.usage })} on this computer, of the{" "}
							{formatStorage({ bytes: storage.quota })} MagnetCut may use.
						</p>
					)}
					<p className="text-muted-foreground text-xs">
						Completely free and open source, under the GNU AGPL 3.0 licence. No
						ads, no telemetry, no account.
					</p>
					<p className="text-muted-foreground text-xs">
						Based on{" "}
						<a
							href={OPENCUT_URL}
							target="_blank"
							rel="noreferrer"
							className="underline underline-offset-2"
						>
							OpenCut
						</a>
						, under the MIT licence.
					</p>
					<a
						href={SOURCE_URL}
						target="_blank"
						rel="noreferrer"
						className="text-sm underline-offset-4 hover:underline"
					>
						Source
					</a>
				</div>
			</DialogContent>
		</Dialog>
	);
}

function formatStorage({ bytes }: { bytes: number }): string {
	if (bytes < 1e6) return "less than 1 MB";
	if (bytes < 1e9) return `${Math.round(bytes / 1e6)} MB`;
	const gigabytes = bytes / 1e9;
	return `${gigabytes < 10 ? gigabytes.toFixed(1) : Math.round(gigabytes)} GB`;
}

/** What the projects and media take, of what the web view lets the app keep. */
function useStorageEstimate({ isOpen }: { isOpen: boolean }) {
	const [estimate, setEstimate] = useState<{
		usage: number;
		quota: number;
	} | null>(null);
	useEffect(() => {
		if (!isOpen || !navigator.storage?.estimate) return;
		let isCurrent = true;
		void navigator.storage.estimate().then(({ usage, quota }) => {
			if (isCurrent && usage !== undefined && quota) {
				setEstimate({ usage, quota });
			}
		});
		return () => {
			isCurrent = false;
		};
	}, [isOpen]);
	return estimate;
}

/** Whether the daily check is on, and Check Now. */
function UpdateLine() {
	const checksForUpdates = useSettingsStore((state) => state.checksForUpdates);
	const isChecking = useAppDialogsStore((state) => state.isCheckingForUpdates);

	return (
		<div className="flex items-center gap-2.5">
			<span className="text-muted-foreground text-xs">
				{checksForUpdates
					? "Checks for updates once a day"
					: "Update checks are off"}
			</span>
			<Button
				size="sm"
				variant="outline"
				disabled={isChecking}
				onClick={() => void checkForUpdatesNow()}
			>
				{isChecking ? "Checking…" : "Check Now"}
			</Button>
		</div>
	);
}
