"use client";

import { useEffect, useState } from "react";
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
	SelectItem,
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
import { Check, Copy, Download, RotateCcw } from "lucide-react";
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
import { DEFAULT_EXPORT_OPTIONS } from "@/export/defaults";
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
	getVideoBitrate,
	type ExportAudioCodec,
	type ExportVideoCodec,
	type ExportVideoQuality,
} from "@/export/settings";
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

type QualityMode = ExportVideoQuality["mode"];

const QUALITY_MODES: { value: QualityMode; label: string }[] = [
	{ value: "level", label: "Level" },
	{ value: "bitrate", label: "Bitrate" },
	{ value: "size", label: "File size" },
];

function isQualityMode(value: string): value is QualityMode {
	return QUALITY_MODES.some((mode) => mode.value === value);
}

/** In decimal megabytes, as Finder and Explorer count them. */
function formatMegabytes({ bytes }: { bytes: number }): string {
	const megabytes = bytes / 1_000_000;
	if (megabytes >= 1000) return `${(megabytes / 1000).toFixed(1)} GB`;
	return `${megabytes < 10 ? megabytes.toFixed(1) : Math.round(megabytes)} MB`;
}

/** The codecs this computer encodes at the size chosen, asked of the web view. */
function useEncodableCodecs({
	width,
	height,
}: {
	width: number;
	height: number;
}): Set<ExportVideoCodec> | null {
	const [encodable, setEncodable] = useState<Set<ExportVideoCodec> | null>(
		null,
	);
	useEffect(() => {
		let isCurrent = true;
		const codecs: ExportVideoCodec[] = ["avc", "hevc", "vp9", "av1"];
		void Promise.all(
			codecs.map((codec) =>
				canEncodeVideo(codec, { width, height }).catch(() => false),
			),
		).then((results) => {
			if (!isCurrent) return;
			setEncodable(new Set(codecs.filter((_, index) => results[index])));
		});
		return () => {
			isCurrent = false;
		};
	}, [width, height]);
	return encodable;
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
	const defaults = DEFAULT_EXPORT_OPTIONS;
	const [format, setFormat] = useState<ExportFormat>(defaults.format);
	const [videoCodec, setVideoCodec] = useState<ExportVideoCodec>(
		defaults.videoCodec,
	);
	const [qualityMode, setQualityMode] = useState<QualityMode>("level");
	const [level, setLevel] = useState<ExportQuality>(defaults.quality.level);
	const [videoKbps, setVideoKbps] = useState(8000);
	const [megabytes, setMegabytes] = useState(25);
	// The shorter side; none for the project's size.
	const [shortSide, setShortSide] = useState<number | undefined>();
	const [fpsLabel, setFpsLabel] = useState<string | undefined>();
	const [shouldIncludeAudio, setShouldIncludeAudio] = useState(true);
	const [audioCodec, setAudioCodec] = useState<ExportAudioCodec>(
		defaults.audio.codec,
	);
	const [audioKbps, setAudioKbps] = useState(defaults.audio.kbps);
	const [channels, setChannels] = useState<1 | 2>(defaults.audio.channels);

	const canvasSize = activeProject.settings.canvasSize;
	const outputSize = fitExportSize({ canvas: canvasSize, shortSide });
	const encodable = useEncodableCodecs(outputSize);
	const fps =
		FRAME_RATE_PRESETS.find((preset) => preset.label === fpsLabel)?.rate ??
		activeProject.settings.fps;
	const quality: ExportVideoQuality =
		qualityMode === "level"
			? { mode: "level", level }
			: qualityMode === "bitrate"
				? { mode: "bitrate", kbps: videoKbps }
				: { mode: "size", megabytes };
	const audio = shouldIncludeAudio
		? { codec: audioCodec, kbps: audioKbps, channels }
		: null;
	const duration = editor.timeline.getTotalDuration() / TICKS_PER_SECOND;
	const audioBitrate = audio ? audio.kbps * 1000 : 0;
	const videoBitrate = getVideoBitrate({
		quality,
		codec: videoCodec,
		...outputSize,
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
		setFormat(value);
		setVideoCodec(fitVideoCodec({ format: value, codec: videoCodec }));
		const codec = fitAudioCodec({ format: value, codec: audioCodec });
		if (codec !== audioCodec) {
			setAudioCodec(codec);
			setAudioKbps(DEFAULT_AUDIO_KBPS[codec]);
		}
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
				fps,
				audio,
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
	const summary = [
		`${VIDEO_CODEC_NAMES[videoCodec]}, ${outputSize.width}×${outputSize.height}, ${+frameRateToFloat(fps).toFixed(3)} fps`,
		audio
			? `${AUDIO_CODEC_NAMES[audio.codec]} ${audio.kbps} kbit/s${audio.channels === 1 ? " mono" : ""}`
			: "no sound",
		`about ${formatMegabytes({ bytes: estimatedBytes })}`,
	].join(" · ");

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
															if (codec) setVideoCodec(codec);
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
											</SectionFields>
										</SectionContent>
									</Section>

									<Section collapsible defaultOpen={false}>
										<SectionHeader>
											<SectionTitle>Quality</SectionTitle>
										</SectionHeader>
										<SectionContent>
											<SectionFields>
												<RadioGroup
													className="flex gap-4"
													value={qualityMode}
													onValueChange={(value) => {
														if (isQualityMode(value)) setQualityMode(value);
													}}
												>
													{QUALITY_MODES.map((mode) => (
														<div
															key={mode.value}
															className="flex items-center space-x-2"
														>
															<RadioGroupItem
																value={mode.value}
																id={`quality-${mode.value}`}
															/>
															<Label htmlFor={`quality-${mode.value}`}>
																{mode.label}
															</Label>
														</div>
													))}
												</RadioGroup>
												{qualityMode === "level" && (
													<Select
														value={level}
														onValueChange={(value) => {
															if (isExportQuality(value)) setLevel(value);
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
																if (value > 0) setVideoKbps(value);
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
																if (value > 0) setMegabytes(value);
															}}
														/>
													</SectionField>
												)}
											</SectionFields>
										</SectionContent>
									</Section>

									<Section collapsible defaultOpen={false}>
										<SectionHeader>
											<SectionTitle>Size and frame rate</SectionTitle>
										</SectionHeader>
										<SectionContent>
											<SectionFields>
												<SectionField label="Size">
													<Select
														value={shortSide ? String(shortSide) : "project"}
														onValueChange={(value) =>
															setShortSide(
																value === "project" ? undefined : Number(value),
															)
														}
													>
														<SelectTrigger variant="outline">
															<SelectValue />
														</SelectTrigger>
														<SelectContent position="popper">
															<SelectItem value="project">
																{`The project's (${canvasSize.width}×${canvasSize.height})`}
															</SelectItem>
															{SIZE_PRESETS.filter(
																(preset) =>
																	preset.shortSide <
																	Math.min(canvasSize.width, canvasSize.height),
															).map((preset) => (
																<SelectItem
																	key={preset.shortSide}
																	value={String(preset.shortSide)}
																>
																	{preset.label}
																</SelectItem>
															))}
														</SelectContent>
													</Select>
												</SectionField>
												<SectionField label="Frame rate">
													<Select
														value={fpsLabel ?? "project"}
														onValueChange={(value) =>
															setFpsLabel(value === "project" ? undefined : value)
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
											<SectionTitle>Audio</SectionTitle>
										</SectionHeader>
										<SectionContent>
											<SectionFields>
												<div className="flex items-center space-x-2">
													<Checkbox
														id="include-audio"
														checked={shouldIncludeAudio}
														onCheckedChange={(checked) =>
															setShouldIncludeAudio(!!checked)
														}
													/>
													<Label htmlFor="include-audio">
														Include audio in export
													</Label>
												</div>
												{shouldIncludeAudio && (
													<div className="grid grid-cols-3 gap-2">
														<Select
															value={audioCodec}
															onValueChange={(value) => {
																const codec = FORMAT_CODECS[format].audio.find(
																	(candidate) => candidate === value,
																);
																if (!codec) return;
																setAudioCodec(codec);
																setAudioKbps(DEFAULT_AUDIO_KBPS[codec]);
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
															onValueChange={(value) => setAudioKbps(Number(value))}
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
																setChannels(value === "1" ? 1 : 2)
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
