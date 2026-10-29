import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useAppDialogsStore } from "../app-dialogs-store";
import { useAppInfo } from "../app-info";
import { useSettingsStore } from "../settings-store";
import { checkForUpdatesNow } from "../updates";

const THEMES = [
	{ value: "system", label: "System" },
	{ value: "light", label: "Light" },
	{ value: "dark", label: "Dark" },
];

export function SettingsDialog({
	isOpen,
	onOpenChange,
}: {
	isOpen: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const info = useAppInfo();

	return (
		<Dialog open={isOpen} onOpenChange={onOpenChange}>
			<DialogContent onOpenAutoFocus={(event) => event.preventDefault()}>
				<DialogHeader>
					<DialogTitle>Settings</DialogTitle>
				</DialogHeader>
				<DialogBody className="gap-6">
					<AppearanceSetting />
					{info?.updates && <UpdatesSetting />}
				</DialogBody>
			</DialogContent>
		</Dialog>
	);
}

function AppearanceSetting() {
	const { theme, setTheme } = useTheme();

	return (
		<section className="flex items-center justify-between gap-4">
			<Label>Appearance</Label>
			<ToggleGroup
				type="single"
				variant="outline"
				value={theme}
				onValueChange={(value) => {
					if (value) setTheme(value);
				}}
			>
				{THEMES.map(({ value, label }) => (
					<ToggleGroupItem key={value} value={value} className="px-3">
						{label}
					</ToggleGroupItem>
				))}
			</ToggleGroup>
		</section>
	);
}

function UpdatesSetting() {
	const checksForUpdates = useSettingsStore((state) => state.checksForUpdates);
	const lastUpdateCheck = useSettingsStore((state) => state.lastUpdateCheck);
	const setChecksForUpdates = useSettingsStore(
		(state) => state.setChecksForUpdates,
	);
	const isChecking = useAppDialogsStore((state) => state.isCheckingForUpdates);

	return (
		<section className="flex flex-col gap-3">
			<div className="flex items-start justify-between gap-4">
				<div className="flex flex-col gap-1">
					<Label htmlFor="checks-for-updates">
						Check for updates automatically
					</Label>
					<p className="text-muted-foreground text-xs">
						Once a day, from GitHub. Updates are signed, and nothing else is
						sent.
					</p>
				</div>
				<Switch
					id="checks-for-updates"
					checked={checksForUpdates}
					onCheckedChange={(checked) =>
						setChecksForUpdates({ enabled: checked })
					}
				/>
			</div>
			<div className="flex items-center justify-between gap-4">
				<span className="text-muted-foreground text-xs">
					{lastUpdateCheck === null
						? "Not checked yet"
						: `Last checked ${new Date(lastUpdateCheck).toLocaleString(
								undefined,
								{ dateStyle: "medium", timeStyle: "short" },
							)}`}
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
		</section>
	);
}
