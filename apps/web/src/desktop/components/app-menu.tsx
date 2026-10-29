"use client";

import {
	InformationCircleIcon,
	Settings02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DEFAULT_LOGO_URL } from "@/site/brand";
import { useAppDialogsStore } from "../app-dialogs-store";

/** Settings and About, for the menus under the logo. */
export function AppMenuItems() {
	const setOpenDialog = useAppDialogsStore((state) => state.setOpenDialog);

	return (
		<>
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

/** The logo, opening Settings and About, where there's no project menu. */
export function AppMenu() {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					className="p-1 rounded-sm size-8"
					aria-label="MagnetCut menu"
				>
					<Image
						src={DEFAULT_LOGO_URL}
						alt=""
						width={32}
						height={32}
						className="invert dark:invert-0 size-5"
					/>
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="z-100 w-44">
				<AppMenuItems />
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
