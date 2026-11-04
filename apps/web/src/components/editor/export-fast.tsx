"use client";

import { useEffect, useMemo, useState } from "react";
import { Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { SectionField } from "@/components/section";
import { useEditor } from "@/editor/use-editor";
import { EXPORT_FORMAT_VALUES, type ExportFormat } from "@/export";
import type { ExportChoices } from "@/export/choices";
import {
	FAST_MODES,
	FAST_MODE_HINTS,
	FAST_MODE_NAMES,
	listFastLosses,
	type FastMode,
} from "@/export/fast/clips";
import {
	getFastFormats,
	inspectFastExport,
	type FastExportInfo,
} from "@/export/fast/exporter";
import { useConformStore } from "@/export/fast/conform-store";
import { AUDIO_CODEC_NAMES, FORMAT_NAMES } from "@/export/settings";
import type { SceneTracks } from "@/timeline";

const CODEC_NAMES: Record<string, string> = {
	avc: "H.264",
	hevc: "HEVC",
	vp9: "VP9",
	av1: "AV1",
	vp8: "VP8",
	aac: "AAC",
	opus: "Opus",
	mp3: "MP3",
	ac3: "AC-3",
	eac3: "E-AC-3",
	flac: "FLAC",
};

function nameCodec({ codec }: { codec: string }): string {
	return CODEC_NAMES[codec] ?? codec.toUpperCase();
}

const FAST_MODE_WHAT =
	"Copies the clips on the main track out of their files instead of drawing and encoding every frame again: for a slow or busy computer, or to keep the original quality. What the timeline adds on top (transitions, effects, text, other video tracks) is left out; the audio tracks are mixed in.";

function isFastMode(value: string): value is FastMode {
	return FAST_MODES.some((mode) => mode === value);
}

/** Off, No re-encoding or Smart Cut, each explained on hover and, once chosen, below. */
export function FastModePicker({
	value,
	onChange,
}: {
	value: FastMode;
	onChange: ({ mode }: { mode: FastMode }) => void;
}) {
	return (
		<div className="flex flex-col gap-1.5 px-3 pt-3">
			<div className="flex items-center justify-between gap-2">
				<Label className="flex items-center gap-1">
					Fast mode
					<Tooltip>
						<TooltipTrigger asChild>
							<button
								type="button"
								aria-label="What Fast mode does"
								className="text-muted-foreground"
							>
								<Info className="size-3.5" />
							</button>
						</TooltipTrigger>
						<TooltipContent className="max-w-72 text-xs">
							{FAST_MODE_WHAT}
						</TooltipContent>
					</Tooltip>
				</Label>
				<ToggleGroup
					type="single"
					variant="outline"
					size="sm"
					value={value}
					onValueChange={(next) => {
						if (isFastMode(next)) onChange({ mode: next });
					}}
				>
					{FAST_MODES.map((mode) => (
						<Tooltip key={mode}>
							{/* On a wrapper: the trigger's own data-state would hide
							    which option is on. */}
							<TooltipTrigger asChild>
								<span className="inline-flex">
									<ToggleGroupItem value={mode} className="px-2 text-xs">
										{FAST_MODE_NAMES[mode]}
									</ToggleGroupItem>
								</span>
							</TooltipTrigger>
							<TooltipContent side="bottom" className="max-w-72 text-xs">
								{FAST_MODE_HINTS[mode]}
							</TooltipContent>
						</Tooltip>
					))}
				</ToggleGroup>
			</div>
			{value !== "off" && (
				<p className="text-muted-foreground text-xs">
					{FAST_MODE_HINTS[value]}
				</p>
			)}
		</div>
	);
}

/** What the clips' files say of a Fast mode export: null until it's known. */
export function useFastExportInfo({
	tracks,
	mode,
	format,
	copiesSound,
}: {
	tracks: SceneTracks;
	mode: FastMode;
	format: ExportFormat;
	copiesSound: boolean;
}): FastExportInfo | null {
	const editor = useEditor();
	const request = useMemo(
		() => ({ tracks, mode, format, copiesSound }),
		[tracks, mode, format, copiesSound],
	);
	// What was found, for which request: nothing's shown while the latest
	// one is being looked at.
	const [found, setFound] = useState<{
		request: typeof request;
		info: FastExportInfo;
	} | null>(null);
	useEffect(() => {
		const { mode: wanted } = request;
		if (wanted === "off") return;
		let isCurrent = true;
		inspectFastExport({
			...request,
			mode: wanted,
			mediaAssets: editor.media.getAssets(),
		})
			.then((info) => {
				if (isCurrent) setFound({ request, info });
			})
			.catch((error: unknown) => {
				console.error("Couldn't look at the clips for Fast mode:", error);
			});
		return () => {
			isCurrent = false;
		};
	}, [editor, request]);
	return mode !== "off" && found?.request === request ? found.info : null;
}

/** The one line the panel says of a Fast mode export before it starts. */
export function getFastSummary({
	info,
	choices,
}: {
	info: FastExportInfo | null;
	choices: ExportChoices;
}): string {
	if (!info) return "Looking at the clips…";
	if (!info.codec) return "Nothing to copy";
	const isSmart = choices.fastMode === "smart" && !info.smartFallback;
	const video = `${nameCodec({ codec: info.codec })} ${info.width}×${info.height} copied, ${
		isSmart ? "re-encoded only at the cuts" : "each clip from a key frame"
	}`;
	const sound = !choices.hasAudio
		? "no sound"
		: info.copiedSound
			? `${nameCodec({ codec: info.copiedSound })} sound copied`
			: `${AUDIO_CODEC_NAMES[choices.audioCodec]} ${choices.audioKbps} kbit/s${choices.channels === 1 ? " mono" : ""}`;
	return `${video} · ${sound}`;
}

/** Fast mode's settings: the container, the sound, and what's left out. */
export function ExportFast({
	choices,
	setChoices,
	info,
	onFormatChange,
}: {
	choices: ExportChoices;
	setChoices: ({ choices }: { choices: Partial<ExportChoices> }) => void;
	info: FastExportInfo | null;
	onFormatChange: ({ value }: { value: ExportFormat }) => void;
}) {
	const tracks = useEditor((e) => e.scenes.getActiveScene().tracks);
	const openConform = useConformStore((state) => state.openDialog);
	const losses = listFastLosses({ tracks });
	const { format, hasAudio, audioPassthrough } = choices;
	const formats = info?.codec
		? getFastFormats({ codec: info.codec })
		: [...EXPORT_FORMAT_VALUES];
	const codec = info?.codec ? nameCodec({ codec: info.codec }) : null;

	return (
		<div className="flex flex-col gap-4 p-3">
			<SectionField label="Container">
				<Select
					value={format}
					onValueChange={(value) => {
						const next = EXPORT_FORMAT_VALUES.find(
							(option) => option === value,
						);
						if (next) onFormatChange({ value: next });
					}}
				>
					<SelectTrigger variant="outline">
						<SelectValue />
					</SelectTrigger>
					<SelectContent position="popper">
						{EXPORT_FORMAT_VALUES.map((option) => (
							<SelectItem
								key={option}
								value={option}
								disabled={!formats.includes(option)}
							>
								{FORMAT_NAMES[option]}
								{codec && !formats.includes(option)
									? ` (can't hold ${codec})`
									: ""}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</SectionField>

			<div className="flex flex-col gap-1">
				<div className="flex items-center space-x-2">
					<Checkbox
						id="fast-audio"
						checked={hasAudio}
						onCheckedChange={(checked) =>
							setChoices({ choices: { hasAudio: !!checked } })
						}
					/>
					<Label htmlFor="fast-audio">
						{"Sound: the clips' own, and the audio tracks"}
					</Label>
				</div>
				{hasAudio && (
					<>
						<div className="flex items-center space-x-2">
							<Checkbox
								id="fast-audio-copy"
								checked={audioPassthrough}
								onCheckedChange={(checked) =>
									setChoices({ choices: { audioPassthrough: !!checked } })
								}
							/>
							<Label htmlFor="fast-audio-copy">
								Copied as it is when it can be
							</Label>
						</div>
						<p className="text-muted-foreground text-xs">
							{info?.copiedSound
								? `The ${nameCodec({ codec: info.copiedSound })} sound is copied, its cuts within a hundredth of a second of the picture's.`
								: "Mixed from the clips and the audio tracks under them, and encoded with the audio settings of Advanced: their volumes are kept. Copied only when the audio tracks are empty, every clip's sound is in the same codec and unchanged, and the container takes it."}
						</p>
					</>
				)}
			</div>

			{losses.length > 0 && (
				<p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-700 dark:text-amber-300">
					{`Left out of a Fast mode export: ${losses.join(", ")}.`}
				</p>
			)}
			{info?.smartFallback && (
				<p className="text-muted-foreground text-xs">{info.smartFallback}</p>
			)}
			{info?.problem && (
				<div className="flex flex-col items-start gap-1.5">
					<p className="text-destructive text-xs">{info.problem}</p>
					{info.canConform && (
						<Button
							variant="outline"
							size="sm"
							className="h-7 text-xs"
							onClick={openConform}
						>
							Make the clips match…
						</Button>
					)}
				</div>
			)}
		</div>
	);
}
