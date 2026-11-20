import {
	Mic01Icon,
	RoboticIcon,
	Settings01Icon,
	Shield01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useTheme } from "next-themes";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useAppDialogsStore } from "../app-dialogs-store";
import { useAppInfo } from "../app-info";
import { useSettingsStore } from "../settings-store";
import { checkForUpdatesNow } from "../updates";
import { AgentsSetting } from "./agents-setting";
import { CrashReportingSetting } from "./crash-reporting-setting";
import { GpuAccelerationSetting } from "./gpu-acceleration-setting";
import { SpeechKeysSetting } from "@/voiceover/components/speech-keys-setting";
import { cn } from "@/utils/ui";

const THEMES = [
	{ value: "system", label: "System" },
	{ value: "light", label: "Light" },
	{ value: "dark", label: "Dark" },
];

type SettingsPage = "general" | "agents" | "voices" | "privacy";

const PAGES: Array<{
	id: SettingsPage;
	label: string;
	summary: string;
	icon: IconSvgElement;
}> = [
	{
		id: "general",
		label: "General",
		summary: "How MagnetCut looks, and its updates.",
		icon: Settings01Icon,
	},
	{
		id: "agents",
		label: "Agents",
		summary: "Claude Code, Codex or OpenCode editing in this window.",
		icon: RoboticIcon,
	},
	{
		id: "voices",
		label: "Voices",
		summary: "Keys for Speak the subtitles, in Voice-over.",
		icon: Mic01Icon,
	},
	{
		id: "privacy",
		label: "Privacy",
		summary: "What MagnetCut may send, and to whom.",
		icon: Shield01Icon,
	},
];

/** Settings, a page at a time: the list of pages down the side. */
export function SettingsDialog({
	isOpen,
	onOpenChange,
}: {
	isOpen: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const [page, setPage] = useState<SettingsPage>("general");
	const current = PAGES.find(({ id }) => id === page) ?? PAGES[0];

	return (
		<Dialog open={isOpen} onOpenChange={onOpenChange}>
			<DialogContent
				className="flex h-[min(38rem,85vh)] max-w-3xl gap-0 overflow-hidden p-0"
				onOpenAutoFocus={(event) => event.preventDefault()}
			>
				<nav className="bg-muted/30 flex w-48 shrink-0 flex-col gap-0.5 border-r p-3">
					<DialogTitle className="px-2 pt-3 pb-4 text-base">
						Settings
					</DialogTitle>
					{PAGES.map(({ id, label, icon }) => (
						<button
							key={id}
							type="button"
							aria-current={id === page ? "page" : undefined}
							onClick={() => setPage(id)}
							className={cn(
								"flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
								id === page
									? "bg-accent text-foreground font-medium"
									: "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
							)}
						>
							<HugeiconsIcon icon={icon} className="size-4" />
							{label}
						</button>
					))}
				</nav>
				<div className="flex min-w-0 flex-1 flex-col">
					<header className="border-b px-6 py-5 pr-14">
						<h2 className="text-base font-semibold">{current.label}</h2>
						<DialogDescription className="text-xs">
							{current.summary}
						</DialogDescription>
					</header>
					<div className="flex flex-1 flex-col gap-6 overflow-y-auto px-6 py-5 [&>section+section]:border-t [&>section+section]:pt-6">
						<SettingsPageContent page={page} />
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}

function SettingsPageContent({ page }: { page: SettingsPage }) {
	const info = useAppInfo();
	switch (page) {
		case "general":
			return (
				<>
					<AppearanceSetting />
					{info?.updates && <UpdatesSetting />}
					<GpuAccelerationSetting />
				</>
			);
		case "agents":
			return <AgentsSetting />;
		case "voices":
			return <SpeechKeysSetting />;
		case "privacy":
			return <CrashReportingSetting />;
	}
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
