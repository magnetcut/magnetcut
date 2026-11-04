"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { VideoCodec } from "mediabunny";
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
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { SectionField } from "@/components/section";
import { useEditor } from "@/editor/use-editor";
import {
	CONFORM_CODEC_NAMES,
	collectConformFiles,
	listConformCodecs,
	listConformSizes,
	planConform,
	type ConformFile,
	type ConformSize,
} from "@/export/fast/conform";
import { runConform, type ConformProgress } from "@/export/fast/conform-run";
import { useConformStore } from "@/export/fast/conform-store";
import {
	CONFORM_FITS,
	CONFORM_FIT_NAMES,
	PART_MARGIN,
	canConvertInto,
	type ConformFit,
} from "@/export/fast/convert";
import { canReadDiskFiles } from "@/media/disk-file";

/**
 * Making the main track's clips match, so Fast mode can join them
 * (docs/CONFORM.md): the files that differ converted once into one size and
 * codec, and their clips given the new files.
 */
export function ConformDialog() {
	const isOpen = useConformStore((state) => state.isDialogOpen);
	// Mounted only while open: each opening looks at the track afresh.
	return isOpen ? <OpenConformDialog /> : null;
}

const FIT_HINTS: Record<ConformFit, string> = {
	contain: "The whole picture, with black bars where its shape differs.",
	cover:
		"The frame filled, the picture's edges cut off where its shape differs.",
	fill: "The frame filled, the picture stretched to it.",
};

function sizeKey({ width, height }: { width: number; height: number }): string {
	return `${width}x${height}`;
}

function formatSeconds({ seconds }: { seconds: number }): string {
	const whole = Math.round(seconds);
	if (whole < 60) return `${whole} s`;
	const minutes = Math.floor(whole / 60);
	return `${minutes}:${String(whole % 60).padStart(2, "0")}`;
}

function describeSize({
	size,
	total,
	isProject,
}: {
	size: ConformSize;
	total: number;
	isProject: boolean;
}): string {
	const share =
		size.seconds > 0 && total > 0
			? `${Math.round((size.seconds / total) * 100)}% of the track`
			: null;
	const notes = [share, isProject ? "the project's" : null].filter(
		(note): note is string => note !== null,
	);
	return `${size.width}×${size.height}${notes.length > 0 ? ` (${notes.join(", ")})` : ""}`;
}

function describeProgress({ progress }: { progress: ConformProgress }): string {
	return `${progress.name}: file ${progress.index + 1} of ${progress.count}, ${Math.floor(progress.progress * 100)}%`;
}

function OpenConformDialog() {
	const editor = useEditor();
	const closeDialog = useConformStore((state) => state.closeDialog);
	const canvas = useEditor((e) => e.project.getActive().settings.canvasSize);

	const [files, setFiles] = useState<ConformFile[] | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	useEffect(() => {
		let isCurrent = true;
		collectConformFiles({
			tracks: editor.scenes.getActiveScene().tracks,
			mediaAssets: editor.media.getAssets(),
		})
			.then((found) => {
				if (isCurrent) setFiles(found);
			})
			.catch((error: unknown) => {
				if (isCurrent) setLoadError(String(error));
			});
		return () => {
			isCurrent = false;
		};
	}, [editor]);

	const sizes = useMemo(() => {
		const onTrack = listConformSizes({ files: files ?? [] });
		const hasCanvas = onTrack.some((size) => sizeKey(size) === sizeKey(canvas));
		return hasCanvas || onTrack.length === 0
			? onTrack
			: [
					...onTrack,
					{ width: canvas.width, height: canvas.height, seconds: 0 },
				];
	}, [files, canvas]);
	const codecs = useMemo(
		() => listConformCodecs({ files: files ?? [] }),
		[files],
	);
	const total = sizes.reduce((sum, size) => sum + size.seconds, 0);

	const [chosenSize, setChosenSize] = useState<string | null>(null);
	const [chosenCodec, setChosenCodec] = useState<VideoCodec | null>(null);
	const [fit, setFit] = useState<ConformFit>("contain");
	const [wholeFiles, setWholeFiles] = useState(false);

	const size =
		sizes.find((option) => sizeKey(option) === chosenSize) ?? sizes[0] ?? null;
	const codec = chosenCodec ?? codecs[0] ?? null;
	const target = useMemo(
		() =>
			size && codec ? { codec, width: size.width, height: size.height } : null,
		[size, codec],
	);
	const plan = useMemo(
		() => (files && target ? planConform({ files, target }) : null),
		[files, target],
	);

	// Whether this computer encodes the target, for the target asked about.
	const [encodable, setEncodable] = useState<{
		key: string;
		can: boolean;
	} | null>(null);
	const targetKey = target ? `${target.codec} ${sizeKey(target)}` : null;
	useEffect(() => {
		if (!target || !targetKey) return;
		let isCurrent = true;
		void canConvertInto({ target }).then((can) => {
			if (isCurrent) setEncodable({ key: targetKey, can });
		});
		return () => {
			isCurrent = false;
		};
	}, [target, targetKey]);
	const canEncode = encodable?.key === targetKey ? encodable.can : null;

	const [progress, setProgress] = useState<ConformProgress | null>(null);
	const [isRunning, setIsRunning] = useState(false);
	const controllerRef = useRef<AbortController | null>(null);
	// Closing the editor mid-way stops it.
	useEffect(() => () => controllerRef.current?.abort(), []);

	const convert = async () => {
		if (!plan) return;
		const controller = new AbortController();
		controllerRef.current = controller;
		setIsRunning(true);
		setProgress(null);
		try {
			const result = await runConform({
				editor,
				plan,
				fit,
				wholeFiles,
				signal: controller.signal,
				onProgress: setProgress,
			});
			if (!result) return;
			const used = `${result.converted} of ${plan.files.length} files converted`;
			if (result.cancelled) {
				toast.info(
					result.converted > 0
						? `Stopped: ${used}, and their clips use them.`
						: "Stopped: nothing was converted.",
				);
			} else {
				toast.success(
					`The clips match: ${used}. Undo puts the old files back.`,
				);
			}
			closeDialog();
		} catch (error) {
			console.error("Couldn't convert the files:", error);
			toast.error("Couldn't convert the files", {
				description: error instanceof Error ? error.message : String(error),
			});
		} finally {
			controllerRef.current = null;
			setIsRunning(false);
			setProgress(null);
		}
	};

	const overall = progress
		? ((progress.index + progress.progress) / progress.count) * 100
		: 0;
	const clipCount =
		plan?.files.reduce((sum, { file }) => sum + file.clipCount, 0) ?? 0;

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !isRunning) closeDialog();
			}}
		>
			<DialogContent
				className="max-w-xl"
				onOpenAutoFocus={(event) => event.preventDefault()}
				onInteractOutside={(event) => {
					if (isRunning) event.preventDefault();
				}}
				onEscapeKeyDown={(event) => {
					if (isRunning) event.preventDefault();
				}}
			>
				<DialogHeader>
					<DialogTitle>Make the clips match</DialogTitle>
					<DialogDescription>
						{
							"Fast mode copies the main track's clips out of their files, and it can join them only when they share one size and one way of encoding. The files that differ can be converted once: their clips then use the new files, and every Fast export after that is a copy."
						}
					</DialogDescription>
				</DialogHeader>
				<DialogBody>
					{loadError && (
						<p className="text-destructive text-sm">{`Couldn't look at the files: ${loadError}`}</p>
					)}
					{!files && !loadError && (
						<p className="text-muted-foreground text-sm">
							Looking at the clips…
						</p>
					)}
					{files && plan && size && codec && (
						<>
							<div className="grid grid-cols-[3fr_2fr] gap-3">
								<SectionField label="Size">
									<Select
										value={sizeKey(size)}
										onValueChange={setChosenSize}
										disabled={isRunning}
									>
										<SelectTrigger variant="outline" className="w-full min-w-0">
											<SelectValue />
										</SelectTrigger>
										<SelectContent position="popper">
											{sizes.map((option) => (
												<SelectItem
													key={sizeKey(option)}
													value={sizeKey(option)}
												>
													{describeSize({
														size: option,
														total,
														isProject: sizeKey(option) === sizeKey(canvas),
													})}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</SectionField>
								<SectionField label="Codec">
									<Select
										value={codec}
										onValueChange={(value) => {
											const next = codecs.find((option) => option === value);
											if (next) setChosenCodec(next);
										}}
										disabled={isRunning}
									>
										<SelectTrigger variant="outline" className="w-full min-w-0">
											<SelectValue />
										</SelectTrigger>
										<SelectContent position="popper">
											{codecs.map((option) => (
												<SelectItem key={option} value={option}>
													{CONFORM_CODEC_NAMES[option] ?? option}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</SectionField>
							</div>
							<SectionField label="A picture of another shape">
								<Select
									value={fit}
									onValueChange={(value) => {
										const next = CONFORM_FITS.find(
											(option) => option === value,
										);
										if (next) setFit(next);
									}}
									disabled={isRunning}
								>
									<SelectTrigger variant="outline" className="w-full min-w-0">
										<SelectValue />
									</SelectTrigger>
									<SelectContent position="popper">
										{CONFORM_FITS.map((option) => (
											<SelectItem key={option} value={option}>
												{CONFORM_FIT_NAMES[option]}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								<p className="text-muted-foreground mt-1 text-xs">
									{FIT_HINTS[fit]}
								</p>
							</SectionField>
							<RadioGroup
								value={wholeFiles ? "whole" : "parts"}
								onValueChange={(value) => setWholeFiles(value === "whole")}
								disabled={isRunning}
								className="gap-1.5"
							>
								<div className="flex items-center gap-2">
									<RadioGroupItem value="parts" id="conform-parts" />
									<Label htmlFor="conform-parts">
										{`Only the parts used, and ${PART_MARGIN} seconds on each side: quicker for long recordings`}
									</Label>
								</div>
								<div className="flex items-center gap-2">
									<RadioGroupItem value="whole" id="conform-whole" />
									<Label htmlFor="conform-whole">
										Whole files, to trim freely afterwards
									</Label>
								</div>
							</RadioGroup>

							{plan.files.length === 0 ? (
								<p className="text-sm">
									{`Every clip on the main track is already ${size.width}×${size.height} ${CONFORM_CODEC_NAMES[codec] ?? codec}: Fast mode can join them as they are.`}
								</p>
							) : (
								<div className="flex flex-col gap-1.5">
									<p className="text-sm">
										{`${plan.files.length} ${plan.files.length === 1 ? "file" : "files"} to convert, for ${clipCount} ${clipCount === 1 ? "clip" : "clips"} and ${formatSeconds({ seconds: plan.seconds })} of the track. ${canReadDiskFiles() ? "The new files go in a folder you pick; the originals aren't touched." : "The new files are kept with the project."}`}
									</p>
									<ul className="bg-muted/40 max-h-40 overflow-y-auto rounded-md border px-2 py-1.5 text-xs">
										{plan.files.map(({ file, difference }) => (
											<li
												key={file.asset.id}
												className="flex justify-between gap-3 py-0.5"
											>
												<span className="truncate">
													<span className="font-medium">{file.asset.name}</span>
													<span className="text-muted-foreground">{` · ${difference}`}</span>
												</span>
												<span className="text-muted-foreground shrink-0 tabular-nums">
													{formatSeconds({ seconds: file.seconds })}
												</span>
											</li>
										))}
									</ul>
									{canEncode === false && (
										<p className="text-destructive text-xs">
											{`This computer can't encode ${CONFORM_CODEC_NAMES[codec] ?? codec} at ${size.width}×${size.height}: pick another size or codec.`}
										</p>
									)}
								</div>
							)}

							{isRunning && (
								<div className="flex flex-col gap-1.5">
									<Progress value={overall} />
									<p className="text-muted-foreground truncate text-xs">
										{progress ? describeProgress({ progress }) : "Starting…"}
									</p>
								</div>
							)}
						</>
					)}
				</DialogBody>
				<DialogFooter>
					{isRunning ? (
						<Button
							variant="outline"
							onClick={() => controllerRef.current?.abort()}
						>
							Cancel
						</Button>
					) : (
						<>
							<Button variant="outline" onClick={closeDialog}>
								{plan && plan.files.length === 0 ? "Close" : "Not now"}
							</Button>
							{plan && plan.files.length > 0 && (
								<Button
									disabled={canEncode !== true}
									onClick={() => void convert()}
								>
									Convert
								</Button>
							)}
						</>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
