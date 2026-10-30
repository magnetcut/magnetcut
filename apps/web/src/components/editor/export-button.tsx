"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { TransitionTopIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { canEncodeVideo } from "mediabunny";
import { Progress } from "@/components/ui/progress";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/utils/ui";
import {
	getExportMimeType,
	getExportFileExtension,
	downloadBuffer,
} from "@/export";
import { Check, Copy, Download, RotateCcw, Trash2 } from "lucide-react";
import {
	EXPORT_FORMAT_VALUES,
	EXPORT_QUALITY_VALUES,
	type ExportFormat,
	type ExportQuality,
} from "@/export";
import {
	Section,
	SectionContent,
	SectionField,
	SectionFields,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import { useEditor } from "@/editor/use-editor";
import {
	BUILT_IN_PRESETS,
	MIN_SHORT_SIDE,
	QUALITY_MODES,
	getChosenOptions,
	isSameExport,
	type QualityMode,
} from "@/export/choices";
import { useExportChoicesStore } from "@/export/choices-store";
import { openAudioPassthrough } from "@/export/passthrough";
import {
	getRevealLabel,
	pickExportFile,
	revealExportFile,
} from "@/export/disk-target";
import { canReadDiskFiles } from "@/media/disk-file";
import {
	AUDIO_BITRATES,
	AUDIO_CODEC_NAMES,
	DEFAULT_AUDIO_KBPS,
	FORMAT_CODECS,
	FORMAT_NAMES,
	FRAME_RATE_PRESETS,
	SIZE_PRESETS,
	VIDEO_CODEC_NAMES,
	estimateExportBytes,
	fitAudioCodec,
	fitExportSize,
	fitVideoCodec,
	getCroppedSize,
	getVideoBitrate,
	isCropped,
	isNativeOnlyCodec,
	NO_CROP,
	type ExportCrop,
	type ExportVideoCodec,
	type WebVideoCodec,
} from "@/export/settings";
import {
	getNativeCapabilities,
	type NativeCapabilities,
} from "@/export/native";
import {
	FILTER_STRENGTHS,
	hasFilters,
	type FilterStrength,
} from "@/export/filters";
import {
	EXPORT_SUBTITLE_MODES,
	SUBTITLE_MODE_NAMES,
	canHoldSubtitleTracks,
} from "@/export/subtitles";
import { getSubtitleTracks } from "@/subtitles/track";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ExportSimple } from "./export-simple";
import { frameRateToFloat } from "@/fps/utils";
import { TICKS_PER_SECOND } from "@/wasm";

function isExportFormat(value: string): value is ExportFormat {
	return EXPORT_FORMAT_VALUES.some((formatValue) => formatValue === value);
}

function isExportQuality(value: string): value is ExportQuality {
	return EXPORT_QUALITY_VALUES.some((qualityValue) => qualityValue === value);
}

export function ExportButton() {
	const [isExportPopoverOpen, setIsExportPopoverOpen] = useState(false);
	const editor = useEditor();
	const activeProject = useEditor((e) => e.project.getActiveOrNull());
	const hasProject = !!activeProject;

	const handlePopoverOpenChange = ({ open }: { open: boolean }) => {
		if (!open) {
			editor.project.cancelExport();
			editor.project.clearExportState();
		}
		setIsExportPopoverOpen(open);
	};

	return (
		<Popover
			open={isExportPopoverOpen}
			onOpenChange={(open) => handlePopoverOpenChange({ open })}
		>
			<PopoverTrigger asChild>
				<button
					type="button"
					className={cn(
						"flex items-center gap-1.5 rounded-md bg-[#38BDF8] px-[0.12rem] py-[0.12rem] text-white",
						hasProject ? "cursor-pointer" : "cursor-not-allowed opacity-50",
					)}
					onClick={hasProject ? () => setIsExportPopoverOpen(true) : undefined}
					disabled={!hasProject}
					onKeyDown={(event) => {
						if (hasProject && (event.key === "Enter" || event.key === " ")) {
							event.preventDefault();
							setIsExportPopoverOpen(true);
						}
					}}
				>
					<div className="relative flex items-center gap-1.5 rounded-[0.6rem] bg-linear-270 from-[#2567EC] to-[#37B6F7] px-4 py-1 shadow-[0_1px_3px_0px_rgba(0,0,0,0.65)]">
						<HugeiconsIcon icon={TransitionTopIcon} className="z-50 size-3.5" />
						<span className="z-50 text-[0.875rem]">Export</span>
						<div className="absolute top-0 left-0 z-10 flex size-full items-center justify-center rounded-[0.6rem] bg-linear-to-t from-white/0 to-white/50">
							<div className="absolute top-[0.08rem] z-50 h-[calc(100%-2px)] w-[calc(100%-2px)] rounded-[0.6rem] bg-linear-270 from-[#2567EC] to-[#37B6F7]"></div>
						</div>
					</div>
				</button>
			</PopoverTrigger>
			{hasProject && <ExportPopover onOpenChange={setIsExportPopoverOpen} />}
		</Popover>
	);
}

const FILTER_STRENGTH_LABELS: Record<FilterStrength, string> = {
	off: "Off",
	light: "Light",
	medium: "Medium",
	strong: "Strong",
};

function isFilterStrength(value: string): value is FilterStrength {
	return FILTER_STRENGTHS.some((strength) => strength === value);
}

function FilterStrengthSelect({
	value,
	onChange,
}: {
	value: FilterStrength;
	onChange: ({ value }: { value: FilterStrength }) => void;
}) {
	return (
		<Select
			value={value}
			onValueChange={(next) => {
				if (isFilterStrength(next)) onChange({ value: next });
			}}
		>
			<SelectTrigger variant="outline">
				<SelectValue />
			</SelectTrigger>
			<SelectContent position="popper">
				{FILTER_STRENGTHS.map((strength) => (
					<SelectItem key={strength} value={strength}>
						{FILTER_STRENGTH_LABELS[strength]}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

const QUALITY_MODE_LABELS: Record<QualityMode, string> = {
	level: "Level",
	bitrate: "Bitrate",
	size: "File size",
	constant: "Constant",
};

function isQualityMode(value: string): value is QualityMode {
	return QUALITY_MODES.some((mode) => mode === value);
}

/** In decimal megabytes, as Finder and Explorer count them. */
function formatMegabytes({ bytes }: { bytes: number }): string {
	const megabytes = bytes / 1_000_000;
	if (megabytes >= 1000) return `${(megabytes / 1000).toFixed(1)} GB`;
	return `${megabytes < 10 ? megabytes.toFixed(1) : Math.round(megabytes)} MB`;
}

/**
 * The codecs this computer encodes at the size chosen: those the web view's
 * encoders take, and those the app's own export makes in this format (AV1
 * only in MP4). ProRes counts whatever the format, as Simple's master file
 * moves to QuickTime for it.
 */
function useEncodableCodecs({
	width,
	height,
	format,
}: {
	width: number;
	height: number;
	format: ExportFormat;
}): Set<ExportVideoCodec> | null {
	const [encodable, setEncodable] = useState<Set<ExportVideoCodec> | null>(
		null,
	);
	useEffect(() => {
		let isCurrent = true;
		const codecs: WebVideoCodec[] = ["avc", "hevc", "vp9", "av1"];
		void Promise.all([
			Promise.all(
				codecs.map((codec) =>
					canEncodeVideo(codec, { width, height }).catch(() => false),
				),
			),
			getNativeCapabilities(),
		]).then(([results, native]) => {
			if (!isCurrent) return;
			const found = new Set<ExportVideoCodec>(
				codecs.filter((_, index) => results[index]),
			);
			for (const codec of native?.videoCodecs ?? []) {
				const fits =
					isNativeOnlyCodec(codec) ||
					(native?.formats.includes(format) &&
						(codec !== "av1" || format === "mp4"));
				if (fits) found.add(codec);
			}
			setEncodable(found);
		});
		return () => {
			isCurrent = false;
		};
	}, [width, height, format]);
	return encodable;
}

/** What the desktop app's native export can do here: null where there's none. */
function useNativeCapabilities(): NativeCapabilities | null {
	const [capabilities, setCapabilities] = useState<NativeCapabilities | null>(
		null,
	);
	useEffect(() => {
		let isCurrent = true;
		void getNativeCapabilities().then((found) => {
			if (isCurrent) setCapabilities(found);
		});
		return () => {
			isCurrent = false;
		};
	}, []);
	return capabilities;
}

/** What Export would copy of the source's sound. */
interface PassthroughInfo {
	codec: string;
	numberOfChannels: number;
	sampleRate: number;
	bitrate: number;
}

const SOURCE_AUDIO_CODEC_NAMES: Record<string, string> = {
	aac: "AAC",
	opus: "Opus",
	mp3: "MP3",
	ac3: "AC-3",
	eac3: "E-AC-3",
	flac: "FLAC",
	vorbis: "Vorbis",
};

function getSourceCodecName({ codec }: { codec: string }): string {
	return SOURCE_AUDIO_CODEC_NAMES[codec] ?? codec.toUpperCase();
}

/**
 * The source's sound Export could copy into this container, if the
 * soundtrack is one file's, uncut: asked when the panel opens and when the
 * container changes.
 */
function usePassthroughInfo({
	format,
}: {
	format: ExportFormat;
}): PassthroughInfo | null {
	const editor = useEditor();
	const [info, setInfo] = useState<PassthroughInfo | null>(null);
	useEffect(() => {
		let isCurrent = true;
		openAudioPassthrough({
			tracks: editor.scenes.getActiveScene().tracks,
			mediaAssets: editor.media.getAssets(),
			duration: editor.timeline.getTotalDuration(),
			format,
		})
			.then((passthrough) => {
				passthrough?.close();
				if (!isCurrent) return;
				setInfo(
					passthrough && {
						codec: passthrough.codec,
						numberOfChannels: passthrough.numberOfChannels,
						sampleRate: passthrough.sampleRate,
						bitrate: passthrough.bitrate,
					},
				);
			})
			.catch((error: unknown) => {
				console.error("Couldn't read the source's sound:", error);
				if (isCurrent) setInfo(null);
			});
		return () => {
			isCurrent = false;
		};
	}, [editor, format]);
	return info;
}

/**
 * A width and height of your own, the picture's shape kept: what's typed is
 * applied on Enter or on leaving the field, as the shorter side it makes.
 */
function CustomSizeFields({
	size,
	picture,
	onShortSideChange,
}: {
	size: { width: number; height: number };
	picture: { width: number; height: number };
	onShortSideChange: ({ shortSide }: { shortSide: number }) => void;
}) {
	type Side = "width" | "height";
	const [draft, setDraft] = useState<{ side: Side; text: string } | null>(
		null,
	);
	const commit = () => {
		if (!draft) return;
		setDraft(null);
		const value = Number(draft.text);
		if (!(value > 0)) return;
		const shortSide =
			(value / picture[draft.side]) * Math.min(picture.width, picture.height);
		onShortSideChange({ shortSide: Math.max(MIN_SHORT_SIDE, shortSide) });
	};
	const renderField = ({ side, label }: { side: Side; label: string }) => (
		<Input
			type="number"
			min={MIN_SHORT_SIDE}
			step={2}
			aria-label={label}
			value={draft?.side === side ? draft.text : String(size[side])}
			onChange={(event) => setDraft({ side, text: event.target.value })}
			onBlur={commit}
			onKeyDown={(event) => {
				if (event.key === "Enter") commit();
			}}
		/>
	);
	return (
		<div className="flex items-center gap-2">
			{renderField({ side: "width", label: "Width" })}
			<span className="text-muted-foreground text-sm">×</span>
			{renderField({ side: "height", label: "Height" })}
		</div>
	);
}

const CROP_SIDES: { side: keyof ExportCrop; label: string }[] = [
	{ side: "top", label: "Top" },
	{ side: "bottom", label: "Bottom" },
	{ side: "left", label: "Left" },
	{ side: "right", label: "Right" },
];

/** The crop, side by side, and a button that finds the black bars. */
function CropFields({
	crop,
	canvas,
	onCropChange,
}: {
	crop: ExportCrop;
	canvas: { width: number; height: number };
	onCropChange: ({ crop }: { crop: ExportCrop }) => void;
}) {
	const editor = useEditor();
	const [isFinding, setIsFinding] = useState(false);
	const [finding, setFinding] = useState<string | null>(null);

	const handleFind = async () => {
		setIsFinding(true);
		setFinding(null);
		try {
			const found = await editor.renderer.detectBlackBars();
			if (!found) return;
			onCropChange({ crop: found });
			setFinding(isCropped({ crop: found }) ? null : "No black bars found");
		} catch (error) {
			console.error("Couldn't look for black bars:", error);
			setFinding("Couldn't look for black bars");
		} finally {
			setIsFinding(false);
		}
	};

	const setSide = ({
		side,
		value,
	}: {
		side: keyof ExportCrop;
		value: number;
	}) => {
		const across =
			side === "top" || side === "bottom" ? canvas.height : canvas.width;
		const opposite = {
			top: "bottom",
			bottom: "top",
			left: "right",
			right: "left",
		} as const;
		// Whole pixels, leaving some picture; the size encoded is made even.
		const most = across - crop[opposite[side]] - MIN_SHORT_SIDE;
		const pixels = Math.floor(Math.max(0, Math.min(value, most)));
		onCropChange({ crop: { ...crop, [side]: pixels } });
	};

	return (
		<div className="flex flex-col gap-2">
			<div className="grid grid-cols-4 gap-2">
				{CROP_SIDES.map(({ side, label }) => (
					<div key={side} className="flex flex-col gap-1">
						<Label
							htmlFor={`crop-${side}`}
							className="text-muted-foreground text-xs"
						>
							{label}
						</Label>
						<Input
							id={`crop-${side}`}
							type="number"
							min={0}
							step={2}
							value={crop[side]}
							onChange={(event) =>
								setSide({ side, value: Number(event.target.value) || 0 })
							}
						/>
					</div>
				))}
			</div>
			<div className="flex items-center gap-2">
				<Button
					variant="outline"
					size="sm"
					disabled={isFinding}
					onClick={() => void handleFind()}
				>
					{isFinding ? "Looking for black bars…" : "Find black bars"}
				</Button>
				{isCropped({ crop }) && !isFinding && (
					<Button
						variant="ghost"
						size="sm"
						onClick={() => {
							onCropChange({ crop: NO_CROP });
							setFinding(null);
						}}
					>
						No crop
					</Button>
				)}
				{finding && (
					<span className="text-muted-foreground text-xs">{finding}</span>
				)}
			</div>
		</div>
	);
}

/** The presets, built in and your own: chosen from, saved and removed. */
function ExportPresetPicker({
	encodable,
}: {
	encodable: Set<ExportVideoCodec> | null;
}) {
	const choices = useExportChoicesStore((state) => state.choices);
	const presets = useExportChoicesStore((state) => state.presets);
	const setChoices = useExportChoicesStore((state) => state.setChoices);
	const savePreset = useExportChoicesStore((state) => state.savePreset);
	const removePreset = useExportChoicesStore((state) => state.removePreset);
	// The name being typed for a new preset; none when not saving one.
	const [newName, setNewName] = useState<string | null>(null);
	const nameInput = useRef<HTMLInputElement>(null);
	const isNaming = newName !== null;
	useEffect(() => {
		if (isNaming) nameInput.current?.focus();
	}, [isNaming]);
	const allPresets = [...presets, ...BUILT_IN_PRESETS];
	const current = allPresets.find((preset) =>
		isSameExport({ a: preset.choices, b: choices }),
	);
	const ownCurrent = presets.find((preset) => preset.id === current?.id);

	const handleSave = () => {
		const name = newName?.trim();
		if (!name) return;
		savePreset({ name });
		setNewName(null);
	};

	return (
		<div className="flex flex-col gap-2 border-b p-3">
			<div className="flex gap-2">
				<Select
					value={current?.id ?? "custom"}
					onValueChange={(id) => {
						const preset = allPresets.find((candidate) => candidate.id === id);
						if (preset) setChoices({ choices: preset.choices });
					}}
				>
					<SelectTrigger variant="outline" className="w-full">
						<SelectValue />
					</SelectTrigger>
					<SelectContent position="popper">
						{!current && <SelectItem value="custom">Custom</SelectItem>}
						{presets.length > 0 && (
							<SelectGroup>
								<SelectLabel>Yours</SelectLabel>
								{presets.map((preset) => (
									<SelectItem key={preset.id} value={preset.id}>
										{preset.name}
									</SelectItem>
								))}
							</SelectGroup>
						)}
						<SelectGroup>
							<SelectLabel>Built in</SelectLabel>
							{BUILT_IN_PRESETS.map((preset) => {
								const isUnavailable =
									!!encodable && !encodable.has(preset.choices.videoCodec);
								return (
									<SelectItem
										key={preset.id}
										value={preset.id}
										disabled={isUnavailable}
									>
										{preset.name}
										{isUnavailable ? " (not on this computer)" : ""}
									</SelectItem>
								);
							})}
						</SelectGroup>
					</SelectContent>
				</Select>
				{ownCurrent ? (
					<Button
						variant="outline"
						className="size-9 shrink-0 p-0"
						aria-label={`Remove the preset ${ownCurrent.name}`}
						onClick={() => removePreset({ id: ownCurrent.id })}
					>
						<Trash2 />
					</Button>
				) : (
					<Button
						variant="outline"
						onClick={() => setNewName(newName === null ? "" : null)}
					>
						Save
					</Button>
				)}
			</div>
			{newName !== null && (
				<form
					className="flex gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						handleSave();
					}}
				>
					<Input
						ref={nameInput}
						placeholder="Preset name"
						aria-label="Preset name"
						value={newName}
						onChange={(event) => setNewName(event.target.value)}
					/>
					<Button type="submit" disabled={!newName.trim()}>
						Save
					</Button>
				</form>
			)}
		</div>
	);
}

function ExportPopover({
	onOpenChange,
}: {
	onOpenChange: (open: boolean) => void;
}) {
	const editor = useEditor();
	const activeProject = useEditor((e) => e.project.getActive());
	const exportState = useEditor((e) => e.project.getExportState());
	const { isExporting, progress, result: exportResult } = exportState;
	const choices = useExportChoicesStore((state) => state.choices);
	const setChoices = useExportChoicesStore((state) => state.setChoices);
	const {
		format,
		videoCodec,
		qualityMode,
		level,
		videoKbps,
		megabytes,
		constantQuality,
		fpsLabel,
		hasAudio,
		audioPassthrough,
		audioCodec,
		audioKbps,
		channels,
		deinterlace,
		denoise,
		sharpen,
		subtitles,
		panelMode,
	} = choices;
	const options = getChosenOptions({ choices });
	const { quality, shortSide, audio, filters } = options;
	const sceneTracks = useEditor((e) => e.scenes.getActiveScene().tracks);
	const hasSubtitles = getSubtitleTracks({ tracks: sceneTracks }).length > 0;

	// The crop is the film's, not the settings': it starts afresh each time.
	const [crop, setCrop] = useState<ExportCrop>(NO_CROP);
	const [isCustomSize, setIsCustomSize] = useState(
		shortSide !== undefined &&
			!SIZE_PRESETS.some((preset) => preset.shortSide === shortSide),
	);

	const canvasSize = activeProject.settings.canvasSize;
	const picture = getCroppedSize({ canvas: canvasSize, crop });
	const pictureShortSide = Math.min(picture.width, picture.height);
	const outputSize = fitExportSize({ canvas: canvasSize, shortSide, crop });
	const encodable = useEncodableCodecs({ ...outputSize, format });
	const native = useNativeCapabilities();
	// QuickTime takes them from the Mac's own export only.
	const canTrackSubtitles =
		canHoldSubtitleTracks({ format }) ||
		(!!native?.subtitleTracks && format === "mov");
	const isProRes = isNativeOnlyCodec(videoCodec);
	// Kept by the Mac's encoders: H.264 and HEVC on Apple silicon, AV1 on any.
	const canKeepQuality =
		(!!native?.constantQuality &&
			(videoCodec === "avc" || videoCodec === "hevc")) ||
		(!!native?.videoCodecs.includes("av1") && videoCodec === "av1");
	const qualityModes = QUALITY_MODES.filter(
		(mode) => mode !== "constant" || !!native || qualityMode === mode,
	);
	const fps = options.fps ?? activeProject.settings.fps;
	const passthroughInfo = usePassthroughInfo({ format });
	const copied = hasAudio && audioPassthrough ? passthroughInfo : null;
	const duration = editor.timeline.getTotalDuration() / TICKS_PER_SECOND;
	const audioBitrate = copied
		? copied.bitrate
		: audio
			? audio.kbps * 1000
			: 0;
	const videoBitrate = getVideoBitrate({
		quality,
		codec: videoCodec,
		...outputSize,
		fps: frameRateToFloat(fps),
		duration,
		audioBitrate,
	});
	const estimatedBytes = estimateExportBytes({
		videoBitrate,
		audioBitrate,
		duration,
	});
	const canEncode = !encodable || encodable.has(videoCodec);

	const handleFormatChange = ({ value }: { value: ExportFormat }) => {
		const codec = fitAudioCodec({ format: value, codec: audioCodec });
		setChoices({
			choices: {
				format: value,
				videoCodec: fitVideoCodec({ format: value, codec: videoCodec }),
				audioCodec: codec,
				audioKbps: codec === audioCodec ? audioKbps : DEFAULT_AUDIO_KBPS[codec],
			},
		});
	};

	const handleExport = async () => {
		if (!activeProject) return;

		// The desktop app asks where first, and writes the file as it goes.
		let path: string | undefined;
		if (canReadDiskFiles()) {
			// Beside the footage, as HandBrake does.
			const footage = editor.media.getAssets().find((asset) => asset.path);
			const picked = await pickExportFile({
				name: activeProject.metadata.name,
				extension: format,
				besidePath: footage?.path,
			});
			if (!picked) return;
			path = picked;
		}

		const result = await editor.project.export({
			options: {
				format,
				videoCodec,
				quality,
				shortSide,
				crop: isCropped({ crop }) ? crop : undefined,
				fps,
				audio,
				filters,
				subtitles: hasSubtitles ? subtitles : undefined,
				path,
			},
		});
		if (result.cancelled) {
			editor.project.clearExportState();
			return;
		}

		if (result.success && result.path) {
			const savedPath = result.path;
			toast.success(`Exported ${savedPath.split(/[\\/]/).pop()}`, {
				action: {
					label: getRevealLabel(),
					onClick: () => {
						revealExportFile({ path: savedPath }).catch((error: unknown) =>
							console.error("Couldn't show the export:", error),
						);
					},
				},
			});
			editor.project.clearExportState();
			onOpenChange(false);
			return;
		}

		if (result.success && result.buffer) {
			downloadBuffer({
				buffer: result.buffer,
				filename: `${activeProject.metadata.name}${getExportFileExtension({ format })}`,
				mimeType: getExportMimeType({ format }),
			});

			editor.project.clearExportState();
			onOpenChange(false);
		}
	};

	const handleCancel = () => {
		editor.project.cancelExport();
	};

	const projectFps = frameRateToFloat(activeProject.settings.fps);
	// In the Simple mode, what it'll be like rather than what it's made with.
	const isSimple = panelMode === "simple";
	const fpsText = +frameRateToFloat(fps).toFixed(3);
	const summary = [
		isSimple
			? `${outputSize.width}×${outputSize.height} at ${fpsText} frames a second`
			: `${VIDEO_CODEC_NAMES[videoCodec]}, ${outputSize.width}×${outputSize.height}, ${fpsText} fps`,
		copied
			? isSimple
				? `the original sound (${copied.numberOfChannels === 6 ? "5.1" : copied.numberOfChannels === 1 ? "mono" : "stereo"})`
				: `${getSourceCodecName(copied)} copied`
			: audio
				? isSimple
					? `${audio.channels === 1 ? "mono" : "stereo"} sound`
					: `${AUDIO_CODEC_NAMES[audio.codec]} ${audio.kbps} kbit/s${audio.channels === 1 ? " mono" : ""}`
				: "no sound",
		filters && hasFilters({ filters })
			? [
					deinterlace && "deinterlaced",
					denoise !== "off" && `denoised (${denoise})`,
					sharpen !== "off" && `sharpened (${sharpen})`,
				]
					.filter(Boolean)
					.join(", ")
			: null,
		qualityMode === "constant" && canKeepQuality && !isProRes
			? "size varies with the picture"
			: `about ${formatMegabytes({ bytes: estimatedBytes })}`,
	]
		.filter(Boolean)
		.join(" · ");

	return (
		<PopoverContent className="bg-background mr-4 flex max-h-(--radix-popover-content-available-height) w-96 flex-col overflow-y-auto p-0">
			{exportResult && !exportResult.success ? (
				<ExportError
					error={exportResult.error || "Unknown error occurred"}
					onRetry={handleExport}
				/>
			) : (
				<>
					<div className="flex items-center justify-between p-3 border-b">
						<h3 className="font-medium text-sm">
							{isExporting ? "Exporting project" : "Export project"}
						</h3>
					</div>

					<div className="flex flex-col gap-4">
						{!isExporting && (
							<>
								<div className="flex flex-col">
									<div className="flex justify-center px-3 pt-3">
										<ToggleGroup
											type="single"
											variant="outline"
											value={panelMode}
											onValueChange={(value) => {
												if (value === "simple" || value === "advanced") {
													setChoices({ choices: { panelMode: value } });
												}
											}}
										>
											<ToggleGroupItem value="simple" className="px-3">
												Simple
											</ToggleGroupItem>
											<ToggleGroupItem value="advanced" className="px-3">
												Advanced
											</ToggleGroupItem>
										</ToggleGroup>
									</div>
									{isSimple ? (
										<ExportSimple
											choices={choices}
											setChoices={setChoices}
											encodable={encodable}
											picture={picture}
											projectFps={projectFps}
										/>
									) : (
										<>
										<ExportPresetPicker encodable={encodable} />
										<Section
											collapsible
											defaultOpen={false}
											showTopBorder={false}
										>
											<SectionHeader>
												<SectionTitle>Format</SectionTitle>
											</SectionHeader>
											<SectionContent>
												<SectionFields>
													<SectionField label="Container">
														<Select
															value={format}
															onValueChange={(value) => {
																if (isExportFormat(value)) {
																	handleFormatChange({ value });
																}
															}}
														>
															<SelectTrigger variant="outline">
																<SelectValue />
															</SelectTrigger>
															<SelectContent position="popper">
																{EXPORT_FORMAT_VALUES.map((value) => (
																	<SelectItem key={value} value={value}>
																		{FORMAT_NAMES[value]}
																	</SelectItem>
																))}
															</SelectContent>
														</Select>
													</SectionField>
													<SectionField label="Video">
														<Select
															value={videoCodec}
															onValueChange={(value) => {
																const codec = FORMAT_CODECS[format].video.find(
																	(candidate) => candidate === value,
																);
																if (codec) setChoices({ choices: { videoCodec: codec } });
															}}
														>
															<SelectTrigger variant="outline">
																<SelectValue />
															</SelectTrigger>
															<SelectContent position="popper">
																{FORMAT_CODECS[format].video.map((codec) => (
																	<SelectItem
																		key={codec}
																		value={codec}
																		disabled={!!encodable && !encodable.has(codec)}
																	>
																		{VIDEO_CODEC_NAMES[codec]}
																		{encodable && !encodable.has(codec)
																			? " (not on this computer)"
																			: ""}
																	</SelectItem>
																))}
															</SelectContent>
														</Select>
													</SectionField>
													{hasSubtitles && (
														<SectionField label="Subtitles">
															<Select
																value={subtitles}
																onValueChange={(value) => {
																	const mode = EXPORT_SUBTITLE_MODES.find(
																		(candidate) => candidate === value,
																	);
																	if (mode) setChoices({ choices: { subtitles: mode } });
																}}
															>
																<SelectTrigger variant="outline">
																	<SelectValue />
																</SelectTrigger>
																<SelectContent position="popper">
																	{EXPORT_SUBTITLE_MODES.map((mode) => (
																		<SelectItem
																			key={mode}
																			value={mode}
																			disabled={mode !== "picture" && !canTrackSubtitles}
																		>
																			{SUBTITLE_MODE_NAMES[mode]}
																			{mode !== "picture" && !canTrackSubtitles
																				? " (not in QuickTime)"
																				: ""}
																		</SelectItem>
																	))}
																</SelectContent>
															</Select>
														</SectionField>
													)}
												</SectionFields>
											</SectionContent>
										</Section>

										<Section collapsible defaultOpen={false}>
											<SectionHeader>
												<SectionTitle>Quality</SectionTitle>
											</SectionHeader>
											<SectionContent>
												<SectionFields>
													{isProRes ? (
														<p className="text-muted-foreground text-xs">
															{`ProRes keeps its own quality: about ${Math.round(videoBitrate / 1_000_000)} Mbit/s.`}
														</p>
													) : (
														<>
															<RadioGroup
																className="flex gap-4"
																value={qualityMode}
																onValueChange={(value) => {
																	if (isQualityMode(value)) {
																		setChoices({ choices: { qualityMode: value } });
																	}
																}}
															>
																{qualityModes.map((mode) => (
																	<div
																		key={mode}
																		className="flex items-center space-x-2"
																	>
																		<RadioGroupItem
																			value={mode}
																			id={`quality-${mode}`}
																		/>
																		<Label htmlFor={`quality-${mode}`}>
																			{QUALITY_MODE_LABELS[mode]}
																		</Label>
																	</div>
																))}
															</RadioGroup>
															{qualityMode === "level" && (
																<Select
																	value={level}
																	onValueChange={(value) => {
																		if (isExportQuality(value)) {
																			setChoices({ choices: { level: value } });
																		}
																	}}
																>
																	<SelectTrigger variant="outline">
																		<SelectValue />
																	</SelectTrigger>
																	<SelectContent position="popper">
																		<SelectItem value="low">Low - Smallest file</SelectItem>
																		<SelectItem value="medium">Medium</SelectItem>
																		<SelectItem value="high">High - Recommended</SelectItem>
																		<SelectItem value="very_high">
																			Very high - Largest file
																		</SelectItem>
																	</SelectContent>
																</Select>
															)}
															{qualityMode === "bitrate" && (
																<SectionField label="Average bitrate (kbit/s)">
																	<Input
																		type="number"
																		min={100}
																		step={100}
																		value={videoKbps}
																		onChange={(event) => {
																			const value = Number(event.target.value);
																			if (value > 0) setChoices({ choices: { videoKbps: value } });
																		}}
																	/>
																</SectionField>
															)}
															{qualityMode === "size" && (
																<SectionField label="File size (MB)">
																	<Input
																		type="number"
																		min={1}
																		value={megabytes}
																		onChange={(event) => {
																			const value = Number(event.target.value);
																			if (value > 0) setChoices({ choices: { megabytes: value } });
																		}}
																	/>
																</SectionField>
															)}
															{qualityMode === "constant" && (
																<SectionField label="Quality (1 to 100)">
																	<Input
																		type="number"
																		min={1}
																		max={100}
																		value={constantQuality}
																		onChange={(event) => {
																			const value = Math.round(Number(event.target.value));
																			if (value >= 1 && value <= 100) {
																				setChoices({ choices: { constantQuality: value } });
																			}
																		}}
																	/>
																	<p className="text-muted-foreground text-xs">
																		{canKeepQuality
																			? "Kept by the Mac's encoder. Where it can't make the film (a clip with a blurred background), a bitrate like it."
																			: "Kept by the Mac's encoders: AV1 on any Mac, H.264 and HEVC on Apple silicon. Here, a bitrate like it."}
																	</p>
																</SectionField>
															)}
														</>
													)}
												</SectionFields>
											</SectionContent>
										</Section>

										<Section collapsible defaultOpen={false}>
											<SectionHeader>
												<SectionTitle>Size, crop and frame rate</SectionTitle>
											</SectionHeader>
											<SectionContent>
												<SectionFields>
													<SectionField label="Size">
														<Select
															value={
																isCustomSize
																	? "custom"
																	: shortSide && shortSide < pictureShortSide
																		? String(shortSide)
																		: "full"
															}
															onValueChange={(value) => {
																setIsCustomSize(value === "custom");
																if (value === "custom") return;
																setChoices({
																	choices: {
																		shortSide: value === "full" ? null : Number(value),
																	},
																});
															}}
														>
															<SelectTrigger variant="outline">
																<SelectValue />
															</SelectTrigger>
															<SelectContent position="popper">
																<SelectItem value="full">
																	{`Full size (${picture.width}×${picture.height})`}
																</SelectItem>
																{SIZE_PRESETS.filter(
																	(preset) => preset.shortSide < pictureShortSide,
																).map((preset) => (
																	<SelectItem
																		key={preset.shortSide}
																		value={String(preset.shortSide)}
																	>
																		{preset.label}
																	</SelectItem>
																))}
																<SelectItem value="custom">Your own</SelectItem>
															</SelectContent>
														</Select>
														{isCustomSize && (
															<CustomSizeFields
																size={outputSize}
																picture={picture}
																onShortSideChange={({ shortSide: side }) =>
																	setChoices({ choices: { shortSide: side } })
																}
															/>
														)}
													</SectionField>
													<SectionField label="Crop">
														<CropFields
															crop={crop}
															canvas={canvasSize}
															onCropChange={({ crop: next }) => setCrop(next)}
														/>
													</SectionField>
													<SectionField label="Frame rate">
														<Select
															value={fpsLabel ?? "project"}
															onValueChange={(value) =>
																setChoices({
																	choices: {
																		fpsLabel: value === "project" ? null : value,
																	},
																})
															}
														>
															<SelectTrigger variant="outline">
																<SelectValue />
															</SelectTrigger>
															<SelectContent position="popper">
																<SelectItem value="project">
																	{`The project's (${+projectFps.toFixed(3)} fps)`}
																</SelectItem>
																{FRAME_RATE_PRESETS.map((preset) => (
																	<SelectItem key={preset.label} value={preset.label}>
																		{`${preset.label} fps`}
																	</SelectItem>
																))}
															</SelectContent>
														</Select>
													</SectionField>
												</SectionFields>
											</SectionContent>
										</Section>

										<Section collapsible defaultOpen={false}>
											<SectionHeader>
												<SectionTitle>Filters</SectionTitle>
											</SectionHeader>
											<SectionContent>
												<SectionFields>
													<div className="flex flex-col gap-1">
														<div className="flex items-center space-x-2">
															<Checkbox
																id="filter-deinterlace"
																checked={deinterlace}
																onCheckedChange={(checked) =>
																	setChoices({ choices: { deinterlace: !!checked } })
																}
															/>
															<Label htmlFor="filter-deinterlace">Deinterlace</Label>
														</div>
														<p className="text-muted-foreground text-xs">
															{"For interlaced video, such as a camcorder's 1080i: keeps one field of each frame and makes the other from it."}
														</p>
													</div>
													<SectionField label="Denoise">
														<FilterStrengthSelect
															value={denoise}
															onChange={({ value }) =>
																setChoices({ choices: { denoise: value } })
															}
														/>
													</SectionField>
													<SectionField label="Sharpen">
														<FilterStrengthSelect
															value={sharpen}
															onChange={({ value }) =>
																setChoices({ choices: { sharpen: value } })
															}
														/>
													</SectionField>
												</SectionFields>
											</SectionContent>
										</Section>

										<Section collapsible defaultOpen={false}>
											<SectionHeader>
												<SectionTitle>Audio</SectionTitle>
											</SectionHeader>
											<SectionContent>
												<SectionFields>
													<div className="flex items-center space-x-2">
														<Checkbox
															id="include-audio"
															checked={hasAudio}
															onCheckedChange={(checked) =>
																setChoices({ choices: { hasAudio: !!checked } })
															}
														/>
														<Label htmlFor="include-audio">
															Include audio in export
														</Label>
													</div>
													{hasAudio && (
														<div className="flex flex-col gap-1">
															<div className="flex items-center space-x-2">
																<Checkbox
																	id="audio-passthrough"
																	checked={audioPassthrough}
																	onCheckedChange={(checked) =>
																		setChoices({
																			choices: { audioPassthrough: !!checked },
																		})
																	}
																/>
																<Label htmlFor="audio-passthrough">
																	{"Copy the source's sound when it can"}
																</Label>
															</div>
															{audioPassthrough && (
																<p className="text-muted-foreground text-xs">
																	{copied
																		? `Copies the ${getSourceCodecName(copied)} sound as it is: ${copied.numberOfChannels === 1 ? "mono" : `${copied.numberOfChannels} channels`}, ${copied.sampleRate / 1000} kHz, about ${Math.round(copied.bitrate / 1000)} kbit/s.`
																		: "Only when the whole soundtrack is one file's sound, uncut, in a codec this container takes. Otherwise:"}
																</p>
															)}
														</div>
													)}
													{hasAudio && !copied && (
														<div className="grid grid-cols-3 gap-2">
															<Select
																value={audioCodec}
																onValueChange={(value) => {
																	const codec = FORMAT_CODECS[format].audio.find(
																		(candidate) => candidate === value,
																	);
																	if (!codec) return;
																	setChoices({
																		choices: {
																			audioCodec: codec,
																			audioKbps: DEFAULT_AUDIO_KBPS[codec],
																		},
																	});
																}}
															>
																<SelectTrigger variant="outline" className="w-full">
																	<SelectValue />
																</SelectTrigger>
																<SelectContent position="popper">
																	{FORMAT_CODECS[format].audio.map((codec) => (
																		<SelectItem key={codec} value={codec}>
																			{AUDIO_CODEC_NAMES[codec]}
																		</SelectItem>
																	))}
																</SelectContent>
															</Select>
															<Select
																value={String(audioKbps)}
																onValueChange={(value) =>
																	setChoices({ choices: { audioKbps: Number(value) } })
																}
															>
																<SelectTrigger variant="outline" className="w-full">
																	<SelectValue />
																</SelectTrigger>
																<SelectContent position="popper">
																	{AUDIO_BITRATES[audioCodec].map((kbps) => (
																		<SelectItem key={kbps} value={String(kbps)}>
																			{`${kbps} kbit/s`}
																		</SelectItem>
																	))}
																</SelectContent>
															</Select>
															<Select
																value={String(channels)}
																onValueChange={(value) =>
																	setChoices({ choices: { channels: value === "1" ? 1 : 2 } })
																}
															>
																<SelectTrigger variant="outline" className="w-full">
																	<SelectValue />
																</SelectTrigger>
																<SelectContent position="popper">
																	<SelectItem value="2">Stereo</SelectItem>
																	<SelectItem value="1">Mono</SelectItem>
																</SelectContent>
															</Select>
														</div>
													)}
												</SectionFields>
											</SectionContent>
										</Section>
										</>
									)}
								</div>

								<div className="flex flex-col gap-2 p-3 pt-0">
									<p className="text-muted-foreground text-xs">{summary}</p>
									<Button
										onClick={handleExport}
										className="w-full gap-2"
										disabled={!canEncode}
									>
										<Download className="size-4" />
										Export
									</Button>
								</div>
							</>
						)}

						{isExporting && (
							<div className="space-y-4 p-3">
								<div className="flex flex-col gap-2">
									<div className="flex items-center justify-between text-center">
										<p className="text-muted-foreground text-sm">
											{Math.round(progress * 100)}%
										</p>
										<p className="text-muted-foreground text-sm">100%</p>
									</div>
									<Progress value={progress * 100} className="w-full" />
								</div>

								<Button
									variant="outline"
									className="w-full rounded-md"
									onClick={handleCancel}
								>
									Cancel
								</Button>
							</div>
						)}
					</div>
				</>
			)}
		</PopoverContent>
	);
}

function ExportError({
	error,
	onRetry,
}: {
	error: string;
	onRetry: () => void;
}) {
	const [copied, setCopied] = useState(false);

	const handleCopy = async () => {
		await navigator.clipboard.writeText(error);
		setCopied(true);
		setTimeout(() => setCopied(false), 1000);
	};

	return (
		<div className="space-y-4 p-3">
			<div className="flex flex-col gap-1.5">
				<p className="text-destructive text-sm font-medium">Export failed</p>
				<p className="text-muted-foreground text-xs">{error}</p>
			</div>

			<div className="flex gap-2">
				<Button
					variant="outline"
					size="sm"
					className="h-8 flex-1 text-xs"
					onClick={handleCopy}
				>
					{copied ? <Check className="text-constructive" /> : <Copy />}
					Copy
				</Button>
				<Button
					variant="outline"
					size="sm"
					className="h-8 flex-1 text-xs"
					onClick={onRetry}
				>
					<RotateCcw />
					Retry
				</Button>
			</div>
		</div>
	);
}
