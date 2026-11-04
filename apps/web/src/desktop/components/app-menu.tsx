"use client";

import {
	FileDownloadIcon,
	FolderOpenIcon,
	InformationCircleIcon,
	Settings02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { isTauri } from "@tauri-apps/api/core";
import { ChevronDown } from "lucide-react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DEFAULT_LOGO_URL } from "@/site/brand";
import { useAppDialogsStore } from "../app-dialogs-store";
import { openProjectFromDisk, saveProjectToDisk } from "../project-files";

/** Opening and saving project files, Settings and About, for the MagnetCut
 * menus (`AppMenuTrigger`). */
export function AppMenuItems() {
	const setOpenDialog = useAppDialogsStore((state) => state.setOpenDialog);
	const router = useRouter();

	return (
		<>
			{isTauri() && (
				<>
					<DropdownMenuItem
						onClick={() =>
							void openProjectFromDisk({ navigate: (url) => router.push(url) })
						}
						icon={<HugeiconsIcon icon={FolderOpenIcon} />}
					>
						Open Project…
					</DropdownMenuItem>
					<DropdownMenuItem
						onClick={() => void saveProjectToDisk()}
						icon={<HugeiconsIcon icon={FileDownloadIcon} />}
					>
						Save Project As…
					</DropdownMenuItem>
				</>
			)}
			<DropdownMenuItem
				onClick={() => setOpenDialog({ dialog: "settings" })}
				icon={<HugeiconsIcon icon={Settings02Icon} />}
			>
				Settings
			</DropdownMenuItem>
			<DropdownMenuItem
				onClick={() => setOpenDialog({ dialog: "about" })}
				icon={<HugeiconsIcon icon={InformationCircleIcon} />}
			>
				About MagnetCut
			</DropdownMenuItem>
		</>
	);
}

/**
 * The app's menu button: its logo and name, as macOS names an app's menu (the
 * logo alone went unnoticed as a menu, and "Menu" didn't say whose it was).
 */
export function AppMenuTrigger() {
	return (
		<DropdownMenuTrigger asChild>
			<Button
				variant="outline"
				size="sm"
				className="h-8 gap-1.5 rounded-sm pl-1.5 pr-2 font-normal data-[state=open]:bg-accent"
			>
				<Image
					src={DEFAULT_LOGO_URL}
					alt=""
					width={32}
					height={32}
					className="invert dark:invert-0 size-5"
				/>
				<span>MagnetCut</span>
				<ChevronDown className="text-muted-foreground size-3.5!" />
			</Button>
		</DropdownMenuTrigger>
	);
}

/** The app's menu where there's no project open: Settings and About. */
export function AppMenu() {
	return (
		<DropdownMenu>
			<AppMenuTrigger />
			<DropdownMenuContent align="start" className="z-100 w-44">
				<AppMenuItems />
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
