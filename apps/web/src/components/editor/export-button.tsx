"use client";

import {
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
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
import { Progress } from "@/components/ui/progress";
import { Checkbox } from "@/components/ui/checkbox";
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
	getPresetChoices,
	isSameExport,
	type QualityMode,
} from "@/export/choices";
import { useExportChoicesStore } from "@/export/choices-store";
import {
	estimateSecondsLeft,
	formatDuration,
	formatExportPercent,
} from "@/export/progress";
import {
	describeAudioPassthrough,
	type PassthroughSound,
} from "@/export/passthrough";
import {
	getRevealLabel,
	isSamePath,
	pickExportFile,
	revealExportFile,
} from "@/export/disk-target";
import { canReadDiskFiles } from "@/media/disk-file";
import {
	firstHardwareCodec,
	getCodecAvailability,
	getEncoderSpeed,
	getHardwareCodecs,
	getSoftwareCodecs,
	isOffered,
	useHardwareOnlyStore,
	type CodecAvailability,
} from "@/export/hardware";
import {
	AUDIO_BITRATES,
	AUDIO_CODEC_NAMES,
	DEFAULT_AUDIO_KBPS,
	FORMAT_CODECS,
	FORMAT_NAMES,
	FRAME_RATE_PRESETS,
	SIZE_PRESETS,
	VIDEO_CODEC_NAMES,
	fitAudioChoice,
	fitExportSize,
	fitVideoCodec,
	getCroppedSize,
	isCropped,
	isNativeOnlyCodec,
	LOUDNESS_TARGETS,
	NO_CROP,
	type ExportCrop,
	type ExportVideoCodec,
} from "@/export/settings";
import {
	isNativeExportRunning,
	subscribeNativeExports,
} from "@/export/native";
import {
	getChannelsName,
	getCodecName,
	getCopiedSound,
	summarizeExport,
} from "@/export/summary";
import {
	EXPORT_PRIORITIES,
	EXPORT_PRIORITY_DESCRIPTIONS,
	EXPORT_PRIORITY_LABELS,
	isExportPriority,
	useExportPriorityStore,
} from "@/export/priority";
import { FILTER_STRENGTHS, type FilterStrength } from "@/export/filters";
import {
	EXPORT_SUBTITLE_MODES,
	SUBTITLE_MODE_NAMES,
	canHoldSubtitleTracks,
} from "@/export/subtitles";
import { getSubtitleTracks } from "@/subtitles/track";
import { ExportSimple } from "./export-simple";
import {
	ExportSummary,
	HardwareOnlyField,
	SegmentedChoice,
} from "./export-parts";
import {
	ExportFast,
	getFastSummary,
	useFastExportInfo,
} from "./export-fast";
import { useEncodableCodecs, useNativeCapabilities } from "./use-export-codecs";
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
	// Anyone's export: the panel's, or an agent's.
	const { isExporting, progress } = useEditor((e) =>
		e.project.getExportState(),
	);

	// Closing the panel only hides it: an export goes on, its progress on the
	// button, until it's cancelled in the panel. What's left of one that
	// ended (its error) goes with the panel.
	const handlePopoverOpenChange = ({ open }: { open: boolean }) => {
		if (!open && !editor.project.getExportState().isExporting) {
			editor.project.clearExportState();
		}
		setIsExportPopoverOpen(open);
	};

	return (
		<Popover
			open={isExportPopoverOpen}
			onOpenChange={(open) => handlePopoverOpenChange({ open })}
		>
			{/* The app's own button, as Export inside the panel, not upstream's gradient. */}
			<PopoverTrigger asChild>
				<Button
					size="sm"
					className="relative h-8 gap-1.5 overflow-hidden rounded-sm px-3 tabular-nums"
					onClick={hasProject ? () => setIsExportPopoverOpen(true) : undefined}
					disabled={!hasProject}
					onKeyDown={(event) => {
						if (hasProject && (event.key === "Enter" || event.key === " ")) {
							event.preventDefault();
							setIsExportPopoverOpen(true);
						}
					}}
				>
					{isExporting ? (
						<>
							{`Exporting ${formatExportPercent({ progress })}`}
							<span
								aria-hidden
								className="bg-primary-foreground/50 absolute bottom-0 left-0 h-0.5"
								style={{ width: `${progress * 100}%` }}
							/>
						</>
					) : (
						<>
							<HugeiconsIcon icon={TransitionTopIcon} className="size-3.5!" />
							Export
						</>
					)}
				</Button>
			</PopoverTrigger>
			{hasProject && (
				<ExportPopover
					isOpen={isExportPopoverOpen}
					onOpenChange={setIsExportPopoverOpen}
				/>
			)}
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

/**
 * How much of the computer the desktop app's export takes: before it starts,
 * and while it runs, which takes a new one at its next frame.
 */
function ExportPriorityField() {
	const priority = useExportPriorityStore((state) => state.priority);
	const setPriority = useExportPriorityStore((state) => state.setPriority);
	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex items-center justify-between gap-3">
				<Label>Priority</Label>
				<Select
					value={priority}
					onValueChange={(next) => {
						if (isExportPriority(next)) setPriority({ priority: next });
					}}
				>
					<SelectTrigger variant="outline" className="w-36">
						<SelectValue />
					</SelectTrigger>
					<SelectContent position="popper">
						{EXPORT_PRIORITIES.map((value) => (
							<SelectItem key={value} value={value}>
								{EXPORT_PRIORITY_LABELS[value]}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
			<p className="text-muted-foreground text-xs">
				{EXPORT_PRIORITY_DESCRIPTIONS[priority]}
			</p>
		</div>
	);
}

/** How long the export has taken, and has left at its pace: each second. */
function ExportTiming({
	progress,
	startedAt,
}: {
	progress: number;
	startedAt?: number;
}) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, []);
	if (startedAt === undefined) return null;
	const elapsedSeconds = (now - startedAt) / 1000;
	const left = estimateSecondsLeft({ progress, elapsedSeconds });
	return (
		<p className="text-muted-foreground text-xs">
			{`${formatDuration({ seconds: elapsedSeconds })} so far · ${
				left === null
					? "working out the time left"
					: `about ${formatDuration({ seconds: left })} left`
			}`}
		</p>
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

/** Beside a codec, or a preset in it: why it can't be chosen, or that it's
 * slow. */
function getCodecNote({
	availability,
}: {
	availability: CodecAvailability;
}): string {
	switch (availability) {
		case "unavailable":
			return " (not on this computer)";
		case "software":
		case "left-out":
			return " (in software)";
		case "available":
			return "";
	}
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
}): PassthroughSound | null {
	const editor = useEditor();
	const [info, setInfo] = useState<PassthroughSound | null>(null);
	useEffect(() => {
		let isCurrent = true;
		describeAudioPassthrough({
			tracks: editor.scenes.getActiveScene().tracks,
			mediaAssets: editor.media.getAssets(),
			duration: editor.timeline.getTotalDuration(),
			format,
		})
			.then((found) => {
				if (isCurrent) setInfo(found);
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
	availabilityOf,
}: {
	/** How a codec is to be had here in a format (`getCodecAvailability`). */
	availabilityOf: ({
		codec,
		format,
	}: {
		codec: ExportVideoCodec;
		format: ExportFormat;
	}) => CodecAvailability;
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
		<div className="flex flex-col gap-2 border-b px-4 py-4">
			<div className="flex gap-2">
				<Select
					value={current?.id ?? "custom"}
					onValueChange={(id) => {
						const preset = allPresets.find((candidate) => candidate.id === id);
						if (preset) {
							setChoices({ choices: getPresetChoices({ preset, choices }) });
						}
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
								const availability = availabilityOf({
									codec: preset.choices.videoCodec,
									format: preset.choices.format,
								});
								return (
									<SelectItem
										key={preset.id}
										value={preset.id}
										disabled={!isOffered({ availability })}
									>
										{preset.name}
										{getCodecNote({ availability })}
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
	isOpen,
	onOpenChange,
}: {
	isOpen: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const editor = useEditor();
	// Whether it's open as an export ends: one that fails with the panel
	// closed says so where it's seen.
	const isOpenRef = useRef(isOpen);
	useEffect(() => {
		isOpenRef.current = isOpen;
	}, [isOpen]);
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
		loudness,
		deinterlace,
		denoise,
		sharpen,
		subtitles,
		panelMode,
	} = choices;
	const options = getChosenOptions({ choices });
	const { quality, shortSide, audio, filters, fastMode = "off" } = options;
	const sceneTracks = useEditor((e) => e.scenes.getActiveScene().tracks);
	const hasSubtitles = getSubtitleTracks({ tracks: sceneTracks }).length > 0;
	const isFast = panelMode === "fast";
	const fastInfo = useFastExportInfo({
		tracks: sceneTracks,
		mode: fastMode,
		format,
		copiesSound: !!audio?.passthrough,
	});

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
	const allEncodable = useEncodableCodecs({ ...outputSize, format });
	const native = useNativeCapabilities();
	const hardwareOnly = useHardwareOnlyStore((state) => state.hardwareOnly);
	const setHardwareOnly = useHardwareOnlyStore(
		(state) => state.setHardwareOnly,
	);
	// The codecs encoded in hardware here, in this format: none known where
	// the app's own export doesn't make it.
	const hardware = useMemo(
		() => getHardwareCodecs({ native, format }),
		[native, format],
	);
	/** How a codec is to be had here, in this format or a preset's. */
	const availabilityOf = ({
		codec,
		format: of,
	}: {
		codec: ExportVideoCodec;
		format: ExportFormat;
	}) =>
		getCodecAvailability({
			codec,
			encodable: allEncodable,
			hardware:
				of === format ? hardware : getHardwareCodecs({ native, format: of }),
			hardwareOnly,
		});
	const availability = availabilityOf({ codec: videoCodec, format });
	// This format's codecs encoded in software, which keeping to hardware
	// leaves out: the switch is shown only when there are some.
	const softwareNames = getSoftwareCodecs({
		format,
		encodable: allEncodable,
		hardware,
	}).map((codec) => VIDEO_CODEC_NAMES[codec]);
	const speed = getEncoderSpeed({ codec: videoCodec, hardware });
	const isNativeRunning = useSyncExternalStore(
		subscribeNativeExports,
		isNativeExportRunning,
		() => false,
	);
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
	const copied = getCopiedSound({ choices, passthrough: passthroughInfo });
	const duration = editor.timeline.getTotalDuration() / TICKS_PER_SECOND;
	const canEncode = isOffered({ availability });
	const cantEncodeReason =
		availability === "left-out"
			? `${VIDEO_CODEC_NAMES[videoCodec]} is encoded in software here: choose another codec, or turn off Hardware-accelerated only.`
			: availability === "unavailable"
				? `This computer can't encode ${VIDEO_CODEC_NAMES[videoCodec]} at ${outputSize.width}×${outputSize.height}.`
				: null;

	const handleHardwareOnly = ({ checked }: { checked: boolean }) => {
		setHardwareOnly({ hardwareOnly: checked });
		// The Simple mode picks again by itself; Advanced keeps its codec
		// unless it's one now left out, for the first of the format's in
		// hardware.
		if (checked && panelMode === "advanced" && availability === "software") {
			const codec = firstHardwareCodec({
				format,
				encodable: allEncodable,
				hardware,
			});
			if (codec) setChoices({ choices: { videoCodec: codec } });
		}
	};

	const handleFormatChange = ({ value }: { value: ExportFormat }) => {
		const audioChoice = fitAudioChoice({
			format: value,
			codec: audioCodec,
			kbps: audioKbps,
		});
		setChoices({
			choices: {
				format: value,
				videoCodec: fitVideoCodec({ format: value, codec: videoCodec }),
				audioCodec: audioChoice.codec,
				audioKbps: audioChoice.kbps,
			},
		});
	};

	const handleExport = async () => {
		if (!activeProject) return;

		// The desktop app asks where first, and writes the file as it goes.
		let path: string | undefined;
		if (canReadDiskFiles()) {
			// Beside the footage, as HandBrake does.
			const assets = editor.media.getAssets();
			const footage = assets.find((asset) => asset.path);
			const picked = await pickExportFile({
				name: activeProject.metadata.name,
				extension: format,
				besidePath: footage?.path,
			});
			if (!picked) return;
			// The export reads the project's files: it can't take one's place.
			const isProjectFile = assets.some(
				(asset) => asset.path && isSamePath({ a: asset.path, b: picked }),
			);
			if (isProjectFile) {
				toast.error("That file is in this project", {
					description: "Export to another name, or another folder.",
				});
				return;
			}
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
				fastMode,
			},
		});
		if (result.cancelled) {
			editor.project.clearExportState();
			return;
		}
		if (!result.success) {
			// The panel shows the error; closed, it's said, and opens on it.
			if (!isOpenRef.current) {
				toast.error("The export failed", {
					description: result.error,
					action: { label: "Show", onClick: () => onOpenChange(true) },
				});
			}
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
	const isSimple = panelMode === "simple";
	const keepsQuality = qualityMode === "constant" && canKeepQuality && !isProRes;
	const summary = summarizeExport({
		choices,
		picture,
		output: outputSize,
		fps: frameRateToFloat(fps),
		duration,
		passthrough: passthroughInfo,
		keepsQuality,
		tags: activeProject.metadata.tags ?? {},
	});

	return (
		<PopoverContent
			className="bg-background mr-4 flex max-h-(--radix-popover-content-available-height) w-[400px] flex-col overflow-y-auto p-0"
			// The panel itself, not its first control, the modes' switch, which
			// would show its focus ring each time the panel opens: Tab moves into
			// the controls from here.
			onOpenAutoFocus={(event) => {
				event.preventDefault();
				if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus();
			}}
		>
			{exportResult && !exportResult.success ? (
				<ExportError
					error={exportResult.error || "Unknown error occurred"}
					onRetry={handleExport}
				/>
			) : (
				<>
					<div className="flex items-center justify-between border-b px-4 py-3">
						<h3 className="text-sm font-medium">
							{isExporting ? "Exporting" : "Export"}
						</h3>
					</div>

					<div className="flex flex-col">
						{!isExporting && (
							<>
								<div className="flex flex-col">
									<div className="px-4 pt-4">
										<SegmentedChoice
											label="How to export"
											value={panelMode}
											options={[
												{ value: "simple", label: "Simple" },
												{ value: "advanced", label: "Advanced" },
												{ value: "fast", label: "Fast" },
											]}
											onChange={({ value }) => setChoices({ choices: { panelMode: value } })}
										/>
									</div>
									{isFast ? (
										<ExportFast
											choices={choices}
											setChoices={setChoices}
											info={fastInfo}
											onFormatChange={handleFormatChange}
										/>
									) : (
									<>
									{isSimple ? (
										<ExportSimple
											choices={choices}
											setChoices={setChoices}
											native={native}
											picture={picture}
											projectFps={projectFps}
											duration={duration}
											copiedBitrate={passthroughInfo?.bitrate ?? null}
										/>
									) : (
										<>
										<ExportPresetPicker availabilityOf={availabilityOf} />
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
																{FORMAT_CODECS[format].video.map((codec) => {
																	const offer = availabilityOf({ codec, format });
																	return (
																		<SelectItem
																			key={codec}
																			value={codec}
																			disabled={!isOffered({ availability: offer })}
																		>
																			{VIDEO_CODEC_NAMES[codec]}
																			{getCodecNote({ availability: offer })}
																		</SelectItem>
																	);
																})}
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
															{`ProRes keeps its own quality: about ${Math.round(summary.videoBitrate / 1_000_000)} Mbit/s.`}
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
																		? `Copies the ${getCodecName({ codec: copied.codec })} sound as it is: ${getChannelsName({ count: copied.numberOfChannels })}, ${copied.sampleRate / 1000} kHz, about ${Math.round(copied.bitrate / 1000)} kbit/s.`
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
													{hasAudio && (
														<SectionField label="Loudness">
															<Select
																value={loudness === null ? "off" : String(loudness)}
																onValueChange={(value) =>
																	setChoices({
																		choices: {
																			loudness:
																				LOUDNESS_TARGETS.find(
																					({ lufs }) => String(lufs) === value,
																				)?.lufs ?? null,
																		},
																	})
																}
															>
																<SelectTrigger variant="outline" className="w-full">
																	<SelectValue />
																</SelectTrigger>
																<SelectContent position="popper">
																	<SelectItem value="off">As it is</SelectItem>
																	{LOUDNESS_TARGETS.map(({ lufs, name }) => (
																		<SelectItem key={lufs} value={String(lufs)}>
																			{name}
																		</SelectItem>
																	))}
																</SelectContent>
															</Select>
															{loudness !== null && (
																<p className="text-muted-foreground text-xs">
																	{"The whole mix is measured first, then turned up or down to it, the limiter keeping peaks under -1 dB. The source's sound isn't copied."}
																</p>
															)}
														</SectionField>
													)}
												</SectionFields>
											</SectionContent>
										</Section>
										</>
									)}
									</>
									)}
								</div>

								<div className="bg-muted/30 flex flex-col gap-4 border-t px-4 py-4">
									{isFast ? (
										<ExportSummary
											details={getFastSummary({ info: fastInfo, choices })}
										/>
									) : (
										<div className="flex flex-col gap-2">
											<ExportSummary
												title={VIDEO_CODEC_NAMES[videoCodec]}
												details={summary.details}
												size={summary.size}
												speed={speed}
											/>
											{summary.limitWarning && (
												<p className="text-xs text-amber-700 dark:text-amber-300">
													{summary.limitWarning}
												</p>
											)}
											{cantEncodeReason && (
												<p className="text-xs text-amber-700 dark:text-amber-300">
													{cantEncodeReason}
												</p>
											)}
										</div>
									)}
									{summary.tags && (
										<div className="flex flex-col gap-0.5 text-xs">
											<p className="text-muted-foreground">{summary.tags.text}</p>
											{summary.tags.warning && (
												<p className="text-amber-700 dark:text-amber-300">
													{summary.tags.warning}
												</p>
											)}
										</div>
									)}
									{!isFast && (softwareNames.length > 0 || native?.priority) && (
										<div className="flex flex-col gap-3 border-t pt-3">
											{softwareNames.length > 0 && (
												<HardwareOnlyField
													checked={hardwareOnly}
													leftOut={softwareNames}
													onChange={handleHardwareOnly}
												/>
											)}
											{native?.priority && <ExportPriorityField />}
										</div>
									)}
									<Button
										onClick={handleExport}
										className="w-full gap-2"
										disabled={isFast ? !fastInfo || !!fastInfo.problem : !canEncode}
									>
										<Download className="size-4" />
										Export
									</Button>
								</div>
							</>
						)}

						{isExporting && (
							<div className="flex flex-col gap-4 px-4 py-4">
								<div className="flex flex-col gap-2">
									<div className="flex items-baseline justify-between gap-3">
										<span className="text-3xl font-semibold tabular-nums">
											{formatExportPercent({ progress })}
										</span>
										<ExportTiming
											progress={progress}
											startedAt={exportState.startedAt}
										/>
									</div>
									<Progress value={progress * 100} className="w-full" />
								</div>

								{native?.priority && isNativeRunning && <ExportPriorityField />}

								<Button
									variant="outline"
									className="w-full"
									onClick={handleCancel}
								>
									Cancel export
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
