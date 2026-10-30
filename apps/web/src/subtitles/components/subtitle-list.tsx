import { useMemo, useState } from "react";
import {
	frameRateRetime,
	twoPointRetime,
	type SubtitleFormat,
} from "magnetcut-wasm";
import {
	AddTrackCommand,
	BatchCommand,
	InsertElementCommand,
	UpdateElementsCommand,
} from "@/commands";
import {
	Section,
	SectionContent,
	SectionField,
	SectionFields,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useEditor } from "@/editor/use-editor";
import { FRAME_RATE_PRESETS } from "@/export/settings";
import { frameRateToFloat } from "@/fps/utils";
import type { TextTrack } from "@/timeline";
import { cn } from "@/utils/ui";
import { mediaTimeFromSeconds, mediaTimeToSeconds } from "@/wasm";
import { SUBTITLE_FORMAT_NAMES, saveSubtitleFile } from "../save";
import { buildSubtitleTextElement } from "../build-subtitle-text-element";
import {
	findTimelineSpeech,
	fitTrackToSpeech,
	snapTrackToSpeech,
} from "../sync";
import {
	fixTrackDurations,
	fixTrackOverlaps,
	formatClock,
	getLineUpdates,
	getOriginalLine,
	getReadingSpeed,
	getSubtitleLines,
	getSubtitleTracks,
	getTypedCaption,
	parseClock,
	retimeTrack,
	saveTrack,
	type ElementUpdate,
	type SubtitleLine,
} from "../track";

// The subtitle editor's list (docs/SUBTITLES.md, phases 3 to 6): a subtitle
// track's lines, each editable, and the tools that retime and save them.

const SUBTITLE_FORMATS: SubtitleFormat[] = [
	"srt",
	"vtt",
	"ass",
	"ssa",
	"subviewer",
	"microdvd",
];

// Faster than this, a line asks too much of a reader (Netflix's, for adults).
const MAX_READING_SPEED = 20;

// Kept between one line and the next when overlaps are fixed: two frames at 24.
const OVERLAP_GAP = 2 / 24;

/** Where a line is to be, as two-point sync marks it. */
interface SyncMark {
	from: number;
	to: number;
}

function LineEditor({
	line,
	original,
	now,
	onApply,
	onMark,
}: {
	line: SubtitleLine;
	/** The line it translates, when it's a translation's. */
	original?: string;
	now: number;
	onApply: ({
		start,
		end,
		text,
	}: {
		start: number;
		end: number;
		text: string;
	}) => void;
	onMark: ({ mark }: { mark: SyncMark }) => void;
}) {
	const [start, setStart] = useState(formatClock({ seconds: line.cue.start }));
	const [end, setEnd] = useState(formatClock({ seconds: line.cue.end }));
	const [text, setText] = useState(line.cue.text);
	const parsedStart = parseClock({ text: start });
	const parsedEnd = parseClock({ text: end });
	const isValid =
		parsedStart !== null && parsedEnd !== null && parsedEnd > parsedStart;

	return (
		<div className="flex flex-col gap-2 rounded-md border p-2">
			<div className="flex gap-2">
				<Input
					aria-label="Start"
					value={start}
					onChange={(event) => setStart(event.target.value)}
				/>
				<Input
					aria-label="End"
					value={end}
					onChange={(event) => setEnd(event.target.value)}
				/>
			</div>
			{original !== undefined && (
				<p className="text-muted-foreground text-xs whitespace-pre-line">
					{original}
				</p>
			)}
			<Textarea
				aria-label="Text"
				rows={2}
				value={text}
				onChange={(event) => setText(event.target.value)}
			/>
			<div className="flex gap-2">
				<Button
					size="sm"
					disabled={!isValid}
					onClick={() => {
						if (parsedStart === null || parsedEnd === null) return;
						onApply({ start: parsedStart, end: parsedEnd, text });
					}}
				>
					Apply
				</Button>
				<Button
					size="sm"
					variant="outline"
					onClick={() => onMark({ mark: { from: line.cue.start, to: now } })}
				>
					Spoken now
				</Button>
			</div>
		</div>
	);
}

function SubtitleTools({
	track,
	onApply,
	onMessage,
	onSelectTrack,
}: {
	track: TextTrack;
	onSelectTrack: ({ trackId }: { trackId: string }) => void;
	onApply: ({
		updates,
		done,
	}: {
		updates: ElementUpdate[];
		done: string;
	}) => void;
	onMessage: ({ message }: { message: string }) => void;
}) {
	const editor = useEditor();
	const project = useEditor((e) => e.project.getActive());
	const [shift, setShift] = useState("0.5");
	const [fromRate, setFromRate] = useState("23.976");
	const [toRate, setToRate] = useState("25");
	const [format, setFormat] = useState<SubtitleFormat>("srt");
	const [isBusy, setIsBusy] = useState(false);
	const rateOf = ({ label }: { label: string }) => {
		const preset = FRAME_RATE_PRESETS.find(
			(candidate) => candidate.label === label,
		);
		return preset ? frameRateToFloat(preset.rate) : null;
	};

	const handleLineUp = async () => {
		setIsBusy(true);
		try {
			const speech = await findTimelineSpeech({ editor });
			const result = fitTrackToSpeech({ track, speech });
			if (!result) {
				onMessage({
					message: "There's no speech to line the subtitles up with.",
				});
				return;
			}
			const { fit, updates } = result;
			const percent = (share: number) => `${Math.round(share * 100)}%`;
			onApply({
				updates,
				done: `Lined up with the speech: ${percent(fit.overlapAfter)} of the lines' time over speech, from ${percent(fit.overlapBefore)}.`,
			});
		} catch (error) {
			onMessage({
				message:
					error instanceof Error ? error.message : "Couldn't find the speech.",
			});
		} finally {
			setIsBusy(false);
		}
	};

	const handleSnap = async () => {
		setIsBusy(true);
		try {
			onApply({
				updates: await snapTrackToSpeech({ editor, track }),
				done: "Snapped to where speech starts and ends, and to cuts.",
			});
		} catch (error) {
			onMessage({
				message:
					error instanceof Error ? error.message : "Couldn't find the speech.",
			});
		} finally {
			setIsBusy(false);
		}
	};

	// A track timed as this one, to put each line's translation in.
	const handleTranslate = () => {
		const addTrack = new AddTrackCommand({
			type: "text",
			index: 0,
			subtitles: true,
			name: `${track.name} (translation)`,
			translationOf: track.id,
		});
		const trackId = addTrack.getTrackId();
		const inserts = track.elements.map(
			({ id: _id, ...element }) =>
				new InsertElementCommand({
					placement: { mode: "explicit", trackId },
					element,
				}),
		);
		editor.command.execute({
			command: new BatchCommand([addTrack, ...inserts]),
		});
		onSelectTrack({ trackId });
		onMessage({
			message:
				"A translation track, timed as this one: write each line's translation over it, the original beside it.",
		});
	};

	const handleSave = async () => {
		try {
			const footage = editor.media.getAssets().find((asset) => asset.path);
			const isSaved = await saveSubtitleFile({
				text: saveTrack({
					track,
					format,
					frameRate: frameRateToFloat(project.settings.fps),
				}),
				name: project.metadata.name,
				format,
				besidePath: footage?.path,
			});
			if (isSaved) onMessage({ message: "Subtitles saved." });
		} catch (error) {
			onMessage({
				message:
					error instanceof Error
						? error.message
						: "Couldn't save the subtitles.",
			});
		}
	};

	return (
		<SectionFields>
			<SectionField label="Shift (seconds, later if positive)">
				<div className="flex gap-2">
					<Input
						aria-label="Seconds to shift by"
						value={shift}
						onChange={(event) => setShift(event.target.value)}
					/>
					<Button
						size="sm"
						variant="outline"
						disabled={!Number.isFinite(Number(shift))}
						onClick={() =>
							onApply({
								updates: retimeTrack({
									track,
									retime: { scale: 1, offset: Number(shift) },
								}),
								done: `Shifted by ${shift} s.`,
							})
						}
					>
						Shift
					</Button>
				</div>
			</SectionField>
			<SectionField label="Frame rate (timed for, playing at)">
				<div className="flex gap-2">
					{[
						{ value: fromRate, set: setFromRate, label: "Timed for" },
						{ value: toRate, set: setToRate, label: "Playing at" },
					].map(({ value, set, label }) => (
						<Select key={label} value={value} onValueChange={set}>
							<SelectTrigger variant="outline" aria-label={label}>
								<SelectValue />
							</SelectTrigger>
							<SelectContent position="popper">
								{FRAME_RATE_PRESETS.map((preset) => (
									<SelectItem key={preset.label} value={preset.label}>
										{preset.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					))}
					<Button
						size="sm"
						variant="outline"
						disabled={fromRate === toRate}
						onClick={() => {
							const from = rateOf({ label: fromRate });
							const to = rateOf({ label: toRate });
							if (from === null || to === null) return;
							onApply({
								updates: retimeTrack({
									track,
									retime: frameRateRetime(from, to),
								}),
								done: `Retimed from ${fromRate} to ${toRate} frames a second.`,
							});
						}}
					>
						Convert
					</Button>
				</div>
			</SectionField>
			<div className="flex flex-wrap gap-2">
				<Button
					size="sm"
					variant="outline"
					disabled={isBusy}
					onClick={() => void handleLineUp()}
				>
					{isBusy ? "Finding the speech..." : "Line up with the speech"}
				</Button>
				<Button
					size="sm"
					variant="outline"
					disabled={isBusy}
					onClick={() => void handleSnap()}
				>
					Snap to speech and cuts
				</Button>
				<Button size="sm" variant="outline" onClick={handleTranslate}>
					Translate
				</Button>
				<Button
					size="sm"
					variant="outline"
					onClick={() =>
						onApply({
							updates: fixTrackOverlaps({ track, gap: OVERLAP_GAP }),
							done: "Overlaps fixed.",
						})
					}
				>
					Fix overlaps
				</Button>
				<Button
					size="sm"
					variant="outline"
					onClick={() =>
						onApply({
							updates: fixTrackDurations({ track }),
							done: "Lines made readable.",
						})
					}
				>
					Fix durations
				</Button>
			</div>
			<SectionField label="Save as">
				<div className="flex gap-2">
					<Select
						value={format}
						onValueChange={(value) => {
							const chosen = SUBTITLE_FORMATS.find(
								(candidate) => candidate === value,
							);
							if (chosen) setFormat(chosen);
						}}
					>
						<SelectTrigger variant="outline" aria-label="Format">
							<SelectValue />
						</SelectTrigger>
						<SelectContent position="popper">
							{SUBTITLE_FORMATS.map((candidate) => (
								<SelectItem key={candidate} value={candidate}>
									{SUBTITLE_FORMAT_NAMES[candidate]}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<Button size="sm" variant="outline" onClick={() => void handleSave()}>
						Save...
					</Button>
				</div>
			</SectionField>
		</SectionFields>
	);
}

/** Lines typed while the film plays, each from where its typing began, as
 * in YouTube's editor; the film paused while typing if chosen. */
function TypeAlong({ track }: { track: TextTrack }) {
	const editor = useEditor();
	const canvasSize = useEditor(
		(e) => e.project.getActive().settings.canvasSize,
	);
	const [text, setText] = useState("");
	const [start, setStart] = useState<number | null>(null);
	const [pausesWhileTyping, setPausesWhileTyping] = useState(true);
	const [didPause, setDidPause] = useState(false);

	const finish = () => {
		setText("");
		setStart(null);
		if (didPause) {
			editor.playback.play();
			setDidPause(false);
		}
	};

	return (
		<div className="flex flex-col gap-1.5">
			<Input
				aria-label="Type a line as it plays"
				placeholder="Type a line as it plays, Enter to add it"
				value={text}
				onChange={(event) => {
					const value = event.target.value;
					if (start === null && value.trim()) {
						setStart(
							mediaTimeToSeconds({ time: editor.playback.getCurrentTime() }),
						);
						if (pausesWhileTyping && editor.playback.getIsPlaying()) {
							editor.playback.pause();
							setDidPause(true);
						}
					}
					setText(value);
				}}
				onKeyDown={(event) => {
					if (event.key === "Escape") {
						finish();
						return;
					}
					if (event.key !== "Enter" || start === null || !text.trim()) return;
					event.preventDefault();
					const caption = getTypedCaption({ track, text: text.trim(), start });
					editor.command.execute({
						command: new InsertElementCommand({
							placement: { mode: "explicit", trackId: track.id },
							element: buildSubtitleTextElement({
								index: track.elements.length,
								caption,
								canvasSize,
							}),
						}),
					});
					finish();
				}}
			/>
			<div className="flex items-center space-x-2">
				<Checkbox
					id="subtitles-pause-while-typing"
					checked={pausesWhileTyping}
					onCheckedChange={(checked) => setPausesWhileTyping(!!checked)}
				/>
				<Label htmlFor="subtitles-pause-while-typing">Pause while typing</Label>
			</div>
		</div>
	);
}

/** The subtitle tracks' lines and tools: nothing until there's a track. */
export function SubtitleList() {
	const editor = useEditor();
	const sceneTracks = useEditor((e) => e.scenes.getActiveScene().tracks);
	const currentTime = useEditor((e) => e.playback.getCurrentTime());
	const tracks = useMemo(
		() => getSubtitleTracks({ tracks: sceneTracks }),
		[sceneTracks],
	);
	const [trackId, setTrackId] = useState<string | null>(null);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [marks, setMarks] = useState<SyncMark[]>([]);
	const [message, setMessage] = useState<string | null>(null);
	const track = tracks.find(({ id }) => id === trackId) ?? tracks[0];
	const lines = useMemo(
		() => (track ? getSubtitleLines({ track }) : []),
		[track],
	);
	if (!track) {
		return (
			<Button
				variant="outline"
				className="w-full"
				onClick={() =>
					editor.command.execute({
						command: new AddTrackCommand({
							type: "text",
							index: 0,
							subtitles: true,
						}),
					})
				}
			>
				New subtitle track
			</Button>
		);
	}

	const now = mediaTimeToSeconds({ time: currentTime });
	const selected = lines.find(({ elementId }) => elementId === selectedId);
	const originalTrack = track.translationOf
		? tracks.find(({ id }) => id === track.translationOf)
		: undefined;
	const original =
		selected && originalTrack
			? (getOriginalLine({ original: originalTrack, cue: selected.cue })?.cue
					.text ?? "")
			: undefined;
	const apply = ({
		updates,
		done,
	}: {
		updates: ElementUpdate[];
		done: string;
	}) => {
		if (updates.length === 0) {
			setMessage("Nothing needed changing.");
			return;
		}
		editor.command.execute({ command: new UpdateElementsCommand({ updates }) });
		setMessage(done);
	};

	return (
		<Section collapsible sectionKey="subtitle-list" showTopBorder>
			<SectionHeader>
				<SectionTitle>{`Subtitles (${lines.length})`}</SectionTitle>
			</SectionHeader>
			<SectionContent className="flex flex-col gap-3">
				{tracks.length > 1 && (
					<Select value={track.id} onValueChange={setTrackId}>
						<SelectTrigger variant="outline" aria-label="Subtitle track">
							<SelectValue />
						</SelectTrigger>
						<SelectContent position="popper">
							{tracks.map((candidate, index) => (
								<SelectItem key={candidate.id} value={candidate.id}>
									{`${candidate.name} ${index + 1}`}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				)}
				<div className="flex max-h-72 flex-col overflow-y-auto rounded-md border">
					{lines.map((line) => {
						const speed = getReadingSpeed({ cue: line.cue });
						const isShowing = now >= line.cue.start && now < line.cue.end;
						return (
							<button
								key={line.elementId}
								type="button"
								className={cn(
									"hover:bg-accent flex items-baseline gap-2 border-b px-2 py-1 text-left text-xs last:border-b-0",
									isShowing && "bg-accent/60",
									line.elementId === selectedId && "bg-accent",
								)}
								onClick={() => {
									setSelectedId(line.elementId);
									editor.playback.seek({
										time: mediaTimeFromSeconds({ seconds: line.cue.start }),
									});
								}}
							>
								<span className="text-muted-foreground shrink-0 tabular-nums">
									{formatClock({ seconds: line.cue.start })}
								</span>
								<span className="min-w-0 flex-1 truncate">
									{line.cue.text.replace(/\n/g, " / ")}
								</span>
								<span
									className={cn(
										"shrink-0 tabular-nums",
										speed > MAX_READING_SPEED
											? "text-destructive"
											: "text-muted-foreground",
									)}
									title="Characters a second"
								>
									{Math.round(speed)}
								</span>
							</button>
						);
					})}
				</div>
				{selected && (
					<LineEditor
						key={selected.elementId}
						line={selected}
						original={original}
						now={now}
						onApply={({ start, end, text }) =>
							apply({
								updates: getLineUpdates({
									track,
									lines: [selected],
									cues: [{ ...selected.cue, start, end, text }],
								}),
								done: "Line changed.",
							})
						}
						onMark={({ mark }) => {
							const next = [...marks.slice(-1), mark];
							setMarks(next);
							setMessage(
								next.length < 2
									? "Marked: now mark another line, far from this one."
									: "Two lines marked.",
							);
						}}
					/>
				)}
				{marks.length === 2 && (
					<Button
						size="sm"
						onClick={() => {
							const [a, b] = marks;
							const retime = twoPointRetime(a.from, a.to, b.from, b.to);
							setMarks([]);
							if (!retime) {
								setMessage("Mark two different lines.");
								return;
							}
							apply({
								updates: retimeTrack({ track, retime }),
								done: "Synced on the two lines marked.",
							});
						}}
					>
						Sync on the two lines marked
					</Button>
				)}
				<TypeAlong track={track} />
				<SubtitleTools
					track={track}
					onSelectTrack={({ trackId: next }) => setTrackId(next)}
					onApply={apply}
					onMessage={({ message: next }) => setMessage(next)}
				/>
				{message && <p className="text-muted-foreground text-xs">{message}</p>}
			</SectionContent>
		</Section>
	);
}
