"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useAssetsPanelStore } from "@/components/editor/panels/assets/assets-panel-store";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import {
	Section,
	SectionContent,
	SectionField,
	SectionFields,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useAppDialogsStore } from "@/desktop/app-dialogs-store";
import { useEditor } from "@/editor/use-editor";
import { canReadDiskFiles } from "@/media/disk-file";
import { getSubtitleTracks } from "@/subtitles/track";
import { mediaTimeFromSeconds } from "@/wasm";
import { listInputs } from "../recorder";
import {
	cancelCountIn,
	changeVoiceFolder,
	closeMicrophone,
	ensureVoiceFolder,
	openMicrophone,
	startTake,
	stopTake,
	useRecordingStore,
} from "../recording";
import {
	MAX_SPEED_UP,
	SPEECH_PROVIDERS,
	SPOKEN_TRACK_NAME,
	listCuesToSpeak,
	speakCues,
	speechApi,
	type SpeakResult,
	type SpeechChoice,
	type SpeechModel,
	type SpeechProvider,
	type SpeechVoice,
} from "../speech";

/** The Voice-over tab (docs/VOICEOVER.md): a take from the microphone, or the subtitles spoken. */
export function VoiceoverView() {
	return (
		<PanelView title="Voice-over" contentClassName="px-0 pb-4">
			<RecordSection />
			<SpeakSection />
		</PanelView>
	);
}

// Radix's Select has no empty value: these stand for "none picked".
const SYSTEM_DEVICE = "system";
const DEFAULT_CHOICE = "default";

function formatClock({ seconds }: { seconds: number }): string {
	const whole = Math.max(0, Math.floor(seconds));
	const minutes = Math.floor(whole / 60);
	return `${minutes}:${String(whole % 60).padStart(2, "0")}`;
}

/** The last part of a path, which is what tells folders apart. */
function shortenPath({ path }: { path: string }): string {
	const parts = path.split(/[\\/]/).filter(Boolean);
	return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : path;
}

function SwitchField({
	id,
	label,
	hint,
	checked,
	disabled,
	onCheckedChange,
}: {
	id: string;
	label: string;
	hint: string;
	checked: boolean;
	disabled?: boolean;
	onCheckedChange: (checked: boolean) => void;
}) {
	return (
		<div className="flex items-start justify-between gap-3">
			<div className="flex flex-col gap-1">
				<Label htmlFor={id}>{label}</Label>
				<p className="text-muted-foreground text-xs">{hint}</p>
			</div>
			<Switch
				id={id}
				checked={checked}
				disabled={disabled}
				onCheckedChange={onCheckedChange}
			/>
		</div>
	);
}

function RecordSection() {
	const editor = useEditor();
	const recorder = useRecordingStore((state) => state.recorder);
	const status = useRecordingStore((state) => state.status);
	const count = useRecordingStore((state) => state.count);
	const deviceId = useRecordingStore((state) => state.deviceId);
	const processing = useRecordingStore((state) => state.processing);
	const isolate = useRecordingStore((state) => state.isolate);
	const monitor = useRecordingStore((state) => state.monitor);
	const folder = useRecordingStore((state) => state.folder);
	const error = useRecordingStore((state) => state.error);
	const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
	const meterRef = useRef<HTMLDivElement>(null);
	const clockRef = useRef<HTMLSpanElement>(null);
	const isDesktop = canReadDiskFiles();
	const isTaking =
		status === "counting" || status === "recording" || status === "saving";

	// The microphones, again when one comes or goes, and once their names may be read.
	useEffect(() => {
		let isCurrent = true;
		const refresh = () => {
			listInputs()
				.then((found) => {
					if (isCurrent) setInputs(found);
				})
				.catch(() => undefined);
		};
		refresh();
		navigator.mediaDevices?.addEventListener("devicechange", refresh);
		return () => {
			isCurrent = false;
			navigator.mediaDevices?.removeEventListener("devicechange", refresh);
		};
	}, [recorder]);

	useEffect(() => {
		if (!isDesktop) return;
		ensureVoiceFolder().catch((reason: unknown) =>
			useRecordingStore.setState({ error: String(reason) }),
		);
	}, [isDesktop]);

	// The meter and the clock, drawn a frame at a time rather than rendered.
	useEffect(() => {
		if (!recorder) return;
		let frame = 0;
		const draw = () => {
			const level = recorder.getLevel();
			const db = 20 * Math.log10(Math.max(level, 1e-6));
			const meter = meterRef.current;
			if (meter) {
				meter.style.width = `${Math.max(0, Math.min(100, ((db + 60) / 60) * 100))}%`;
				meter.dataset.clipping = String(level > 0.98);
			}
			const { status: now, startedAt } = useRecordingStore.getState();
			if (clockRef.current) {
				clockRef.current.textContent =
					now === "recording"
						? formatClock({ seconds: (performance.now() - startedAt) / 1000 })
						: "";
			}
			frame = requestAnimationFrame(draw);
		};
		frame = requestAnimationFrame(draw);
		return () => cancelAnimationFrame(frame);
	}, [recorder]);

	// The microphone let go when the tab closes, unless a take is going on.
	useEffect(
		() => () => {
			const { status: now } = useRecordingStore.getState();
			if (now === "ready" || now === "opening") void closeMicrophone();
		},
		[],
	);

	const reopen = ({
		nextDevice,
		nextProcessing,
	}: {
		nextDevice: string | undefined;
		nextProcessing: boolean;
	}) => {
		if (status === "ready" || status === "opening") {
			void openMicrophone({
				deviceId: nextDevice,
				processing: nextProcessing,
			});
		} else {
			useRecordingStore.setState({
				deviceId: nextDevice,
				processing: nextProcessing,
			});
		}
	};

	const microphones = inputs.filter(
		(input) =>
			input.deviceId !== "" &&
			input.deviceId !== "default" &&
			input.deviceId !== "communications",
	);

	return (
		<Section sectionKey="voiceover-record" showTopBorder={false}>
			<SectionHeader>
				<SectionTitle>Record</SectionTitle>
			</SectionHeader>
			<SectionContent className="flex flex-col gap-4">
				<SectionFields>
					<SectionField label="Microphone">
						<Select
							value={deviceId ?? SYSTEM_DEVICE}
							disabled={isTaking}
							onValueChange={(value) =>
								reopen({
									nextDevice: value === SYSTEM_DEVICE ? undefined : value,
									nextProcessing: processing,
								})
							}
						>
							<SelectTrigger className="w-full min-w-0">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value={SYSTEM_DEVICE}>
									The system&apos;s microphone
								</SelectItem>
								{microphones.map((input, index) => (
									<SelectItem key={input.deviceId} value={input.deviceId}>
										{input.label || `Microphone ${index + 1}`}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</SectionField>
				</SectionFields>

				<div
					className="bg-muted h-2 overflow-hidden rounded-full"
					aria-hidden="true"
				>
					<div
						ref={meterRef}
						className="h-full w-0 bg-emerald-500 transition-[width] duration-75 data-[clipping=true]:bg-red-500"
					/>
				</div>

				<RecordButton
					status={status}
					count={count}
					clockRef={clockRef}
					onOpen={() => void openMicrophone({ deviceId, processing })}
					onRecord={() => void startTake({ editor })}
					onCancel={cancelCountIn}
					onStop={() => void stopTake({ editor })}
				/>
				<p className="text-muted-foreground text-xs">
					A take starts at the playhead with the timeline playing, and goes on
					the {`"Voice-over"`} track where it started. Recording over a take
					replaces it.
				</p>
				{error && <p className="text-destructive text-xs">{error}</p>}

				<SwitchField
					id="voiceover-isolate"
					label="Isolate the voice"
					hint="Turns on Reduce noise for the take: its Audio tab changes it."
					checked={isolate}
					onCheckedChange={(checked) =>
						useRecordingStore.setState({ isolate: checked })
					}
				/>
				<SwitchField
					id="voiceover-monitor"
					label="Hear the timeline while recording"
					hint="With headphones on, or the microphone hears the speakers."
					checked={monitor === "heard"}
					disabled={isTaking}
					onCheckedChange={(checked) =>
						useRecordingStore.setState({
							monitor: checked ? "heard" : "muted",
						})
					}
				/>
				<SwitchField
					id="voiceover-processing"
					label="Call-style processing"
					hint="Echo cancellation, levelling and noise suppression, as in calls: they colour the voice."
					checked={processing}
					disabled={isTaking}
					onCheckedChange={(checked) =>
						reopen({ nextDevice: deviceId, nextProcessing: checked })
					}
				/>

				{isDesktop ? (
					<div className="flex items-center justify-between gap-2">
						<p className="text-muted-foreground min-w-0 truncate text-xs">
							{folder
								? `Takes go in ${shortenPath({ path: folder })}`
								: "Takes go in Music/MagnetCut"}
						</p>
						<Button
							size="sm"
							variant="outline"
							disabled={isTaking}
							onClick={() =>
								void changeVoiceFolder().catch((reason: unknown) =>
									toast.error("Couldn't change the folder", {
										description: String(reason),
									}),
								)
							}
						>
							Change…
						</Button>
					</div>
				) : (
					<p className="text-muted-foreground text-xs">
						In a browser, takes are kept with the project. In the desktop app
						they&apos;re files in Music/MagnetCut, kept as you speak.
					</p>
				)}
				{status === "ready" && (
					<Button
						variant="ghost"
						size="sm"
						className="self-start px-0 text-xs"
						onClick={() => void closeMicrophone()}
					>
						Close the microphone
					</Button>
				)}
			</SectionContent>
		</Section>
	);
}

function RecordButton({
	status,
	count,
	clockRef,
	onOpen,
	onRecord,
	onCancel,
	onStop,
}: {
	status: ReturnType<typeof useRecordingStore.getState>["status"];
	count: number;
	clockRef: React.Ref<HTMLSpanElement>;
	onOpen: () => void;
	onRecord: () => void;
	onCancel: () => void;
	onStop: () => void;
}) {
	switch (status) {
		case "off":
			return (
				<Button variant="outline" className="w-full" onClick={onOpen}>
					Open the microphone
				</Button>
			);
		case "opening":
			return (
				<Button variant="outline" className="w-full" disabled>
					<Spinner className="mr-1" />
					Opening…
				</Button>
			);
		case "ready":
			return (
				<Button className="w-full" onClick={onRecord}>
					<span className="mr-1 size-2.5 rounded-full bg-red-500" />
					Record
				</Button>
			);
		case "counting":
			return (
				<Button variant="outline" className="w-full" onClick={onCancel}>
					{`Recording in ${count}… (cancel)`}
				</Button>
			);
		case "recording":
			return (
				<Button variant="destructive" className="w-full" onClick={onStop}>
					<span className="mr-1 size-2.5 bg-current" />
					Stop
					<span ref={clockRef} className="ml-1 tabular-nums" />
				</Button>
			);
		case "saving":
			return (
				<Button variant="outline" className="w-full" disabled>
					<Spinner className="mr-1" />
					Keeping the take…
				</Button>
			);
	}
}

function SpeakSection() {
	return (
		<Section sectionKey="voiceover-speak">
			<SectionHeader>
				<SectionTitle>Speak the subtitles</SectionTitle>
			</SectionHeader>
			<SectionContent className="flex flex-col gap-4">
				{canReadDiskFiles() ? (
					<SpeakFields />
				) : (
					<p className="text-muted-foreground text-xs">
						In the desktop app: it keeps your keys in the keychain, and the
						spoken cues as files.
					</p>
				)}
			</SectionContent>
		</Section>
	);
}

interface ProviderData {
	provider: SpeechProvider;
	voices: SpeechVoice[];
	models: SpeechModel[];
	quota: { used: number; limit: number } | null;
}

function SpeakFields() {
	const editor = useEditor();
	const tracks = useEditor((e) =>
		getSubtitleTracks({ tracks: e.scenes.getActiveScene().tracks }),
	);
	const assets = useEditor((e) => e.media.getAssets());
	const openDialog = useAppDialogsStore((state) => state.openDialog);
	const setOpenDialog = useAppDialogsStore((state) => state.setOpenDialog);
	const setActiveTab = useAssetsPanelStore((state) => state.setActiveTab);
	const [trackId, setTrackId] = useState<string | null>(null);
	const [provider, setProvider] = useState<SpeechProvider>("system");
	const [keys, setKeys] = useState<Record<
		Exclude<SpeechProvider, "system">,
		boolean
	> | null>(null);
	const [data, setData] = useState<ProviderData | null>(null);
	const [loadError, setLoadError] = useState<{
		provider: SpeechProvider;
		message: string;
	} | null>(null);
	const [pickedVoice, setPickedVoice] = useState<string | null>(null);
	const [pickedModel, setPickedModel] = useState<string | null>(null);
	const [instructions, setInstructions] = useState("");
	const [run, setRun] = useState<{
		index: number;
		count: number;
		controller: AbortController;
	} | null>(null);
	const [result, setResult] = useState<SpeakResult | null>(null);

	const track = tracks.find(({ id }) => id === trackId) ?? tracks[0] ?? null;
	const hasKey = provider === "system" || keys?.[provider] === true;

	// The keys, read again whenever Settings closes.
	useEffect(() => {
		if (openDialog !== null) return;
		let isCurrent = true;
		speechApi
			.keys()
			.then((found) => {
				if (isCurrent) setKeys(found);
			})
			.catch((reason: unknown) => {
				if (isCurrent) {
					setLoadError({ provider, message: String(reason) });
				}
			});
		return () => {
			isCurrent = false;
		};
	}, [openDialog, provider]);

	// The provider's voices, models and quota: asked for once it's picked.
	useEffect(() => {
		if (!hasKey) return;
		let isCurrent = true;
		Promise.all([
			speechApi.voices({ provider }),
			speechApi.models({ provider }),
			speechApi.quota({ provider }),
		])
			.then(([voices, models, quota]) => {
				if (!isCurrent) return;
				setData({ provider, voices, models, quota });
				setLoadError((current) =>
					current?.provider === provider ? null : current,
				);
			})
			.catch((reason: unknown) => {
				if (isCurrent) setLoadError({ provider, message: String(reason) });
			});
		return () => {
			isCurrent = false;
		};
	}, [provider, hasKey]);

	const loaded = data?.provider === provider ? data : null;
	const error = loadError?.provider === provider ? loadError.message : null;
	const voices = loaded?.voices ?? [];
	const voice =
		pickedVoice !== null && voices.some(({ id }) => id === pickedVoice)
			? pickedVoice
			: provider === "system"
				? ""
				: (voices[0]?.id ?? null);
	const model =
		pickedModel !== null &&
		(loaded?.models ?? []).some(({ id }) => id === pickedModel)
			? pickedModel
			: null;
	const spokenInstructions =
		provider === "openai" && instructions.trim() ? instructions.trim() : null;

	const choice: SpeechChoice | null = useMemo(
		() =>
			loaded && voice !== null
				? { provider, voice, model, instructions: spokenInstructions }
				: null,
		[loaded, provider, voice, model, spokenInstructions],
	);
	const cues = useMemo(
		() =>
			track && choice
				? listCuesToSpeak({ track, choice, mediaAssets: assets })
				: [],
		[track, choice, assets],
	);
	const toSend = cues.filter(({ asset }) => asset === null);
	const characters = toSend.reduce((sum, { text }) => sum + text.length, 0);
	const providerName =
		SPEECH_PROVIDERS.find(({ value }) => value === provider)?.label ?? provider;
	const chosenVoice = voices.find(({ id }) => id === voice);

	const speak = async () => {
		if (!choice || cues.length === 0) return;
		const controller = new AbortController();
		setResult(null);
		setRun({ index: 0, count: cues.length, controller });
		try {
			const folder = await ensureVoiceFolder();
			if (!folder) throw new Error("There's no folder for the spoken cues.");
			const outcome = await speakCues({
				editor,
				cues,
				choice,
				folder,
				signal: controller.signal,
				onProgress: ({ index, count }) => setRun({ index, count, controller }),
			});
			setResult(outcome);
			const placed = outcome.spoken + outcome.reused;
			if (outcome.cancelled) {
				toast(`Stopped: ${placed} of ${cues.length} cues are on the timeline`);
			} else {
				toast.success(
					`${placed} cues on the "${SPOKEN_TRACK_NAME}" track${
						outcome.reused > 0 ? `, ${outcome.reused} spoken before` : ""
					}`,
				);
			}
		} catch (reason) {
			toast.error("Speaking the subtitles stopped", {
				description: `${String(reason)} The cues spoken so far are on the timeline.`,
			});
		} finally {
			setRun(null);
			if (provider === "elevenlabs") {
				speechApi
					.quota({ provider })
					.then((quota) =>
						setData((current) =>
							current?.provider === provider ? { ...current, quota } : current,
						),
					)
					.catch(() => undefined);
			}
		}
	};

	if (tracks.length === 0) {
		return (
			<div className="flex flex-col gap-2">
				<p className="text-muted-foreground text-xs">
					No subtitles yet: make them, or bring a file in, in Captions.
				</p>
				<Button
					variant="outline"
					size="sm"
					className="self-start"
					onClick={() => setActiveTab("captions")}
				>
					Go to Captions
				</Button>
			</div>
		);
	}

	const isRunning = run !== null;

	return (
		<>
			<SectionFields>
				{tracks.length > 1 && (
					<SectionField label="Subtitles">
						<Select
							value={track?.id}
							disabled={isRunning}
							onValueChange={setTrackId}
						>
							<SelectTrigger className="w-full min-w-0">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{tracks.map(({ id, name }) => (
									<SelectItem key={id} value={id}>
										{name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</SectionField>
				)}
				<SectionField label="Voices from">
					<Select
						value={provider}
						disabled={isRunning}
						onValueChange={(value) => {
							const next = SPEECH_PROVIDERS.find(
								(option) => option.value === value,
							);
							if (!next) return;
							setProvider(next.value);
							setResult(null);
						}}
					>
						<SelectTrigger className="w-full min-w-0">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{SPEECH_PROVIDERS.map(({ value, label }) => (
								<SelectItem key={value} value={value}>
									{label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</SectionField>

				{!hasKey && keys !== null && (
					<div className="flex flex-col gap-2">
						<p className="text-muted-foreground text-xs">
							{`${providerName} needs your own key: it's kept in this computer's keychain, and sent only to ${providerName}.`}
						</p>
						<Button
							variant="outline"
							size="sm"
							className="self-start"
							onClick={() => setOpenDialog({ dialog: "settings" })}
						>
							Add a key in Settings
						</Button>
					</div>
				)}

				{hasKey && !loaded && !error && (
					<p className="text-muted-foreground flex items-center gap-2 text-xs">
						<Spinner /> {`Asking ${providerName} for its voices…`}
					</p>
				)}

				{loaded && (
					<SectionField label="Voice">
						<Select
							value={voice === "" ? DEFAULT_CHOICE : (voice ?? undefined)}
							disabled={isRunning}
							onValueChange={(value) =>
								setPickedVoice(value === DEFAULT_CHOICE ? "" : value)
							}
						>
							<SelectTrigger className="w-full min-w-0">
								<SelectValue placeholder="No voices" />
							</SelectTrigger>
							<SelectContent>
								{provider === "system" && (
									<SelectItem value={DEFAULT_CHOICE}>
										The system&apos;s voice
									</SelectItem>
								)}
								{voices.map(({ id, name, language }) => (
									<SelectItem key={id} value={id}>
										{language ? `${name} (${language})` : name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						{chosenVoice?.description && (
							<p className="text-muted-foreground text-xs">
								{chosenVoice.description}
							</p>
						)}
					</SectionField>
				)}

				{loaded && loaded.models.length > 0 && (
					<SectionField label="Model">
						<Select
							value={model ?? DEFAULT_CHOICE}
							disabled={isRunning}
							onValueChange={(value) =>
								setPickedModel(value === DEFAULT_CHOICE ? null : value)
							}
						>
							<SelectTrigger className="w-full min-w-0">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value={DEFAULT_CHOICE}>
									{`${providerName}'s default`}
								</SelectItem>
								{loaded.models.map(({ id, name }) => (
									<SelectItem key={id} value={id}>
										{name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</SectionField>
				)}

				{loaded && provider === "openai" && (
					<SectionField label="How it's said">
						<Textarea
							rows={2}
							value={instructions}
							disabled={isRunning}
							onChange={(event) => setInstructions(event.target.value)}
							placeholder="Calm and warm, a little slow"
						/>
					</SectionField>
				)}
			</SectionFields>

			{error && <p className="text-destructive text-xs">{error}</p>}

			{choice && cues.length > 0 && (
				<p className="text-muted-foreground text-xs">
					{toSend.length === 0
						? `All ${cues.length} cues were spoken this way before: they're put back from the project.`
						: `${toSend.length} of ${cues.length} cues to speak, ${characters.toLocaleString()} characters${
								provider === "system" ? "" : ` sent to ${providerName}`
							}.`}
					{loaded?.quota &&
						` ${loaded.quota.used.toLocaleString()} of ${loaded.quota.limit.toLocaleString()} characters used this month.`}
				</p>
			)}
			{choice && cues.length === 0 && (
				<p className="text-muted-foreground text-xs">
					These subtitles have no text to speak.
				</p>
			)}

			{run ? (
				<div className="flex flex-col gap-2">
					<Progress value={(run.index / Math.max(1, run.count)) * 100} />
					<div className="flex items-center justify-between gap-2">
						<span className="text-muted-foreground text-xs">
							{`Cue ${run.index + 1} of ${run.count}`}
						</span>
						<Button
							variant="outline"
							size="sm"
							disabled={run.controller.signal.aborted}
							onClick={() => run.controller.abort()}
						>
							Cancel
						</Button>
					</div>
				</div>
			) : (
				<Button
					className="w-full"
					disabled={!choice || cues.length === 0}
					onClick={() => void speak()}
				>
					{toSend.length === 0 && cues.length > 0
						? "Put the spoken cues back"
						: "Speak the subtitles"}
				</Button>
			)}
			<p className="text-muted-foreground text-xs">
				{`Each cue goes on the "${SPOKEN_TRACK_NAME}" track at its start, sped up by at most ${Math.round((MAX_SPEED_UP - 1) * 100)}% if it's a little long; overlapping ones go on a second track. Undo takes them all back.`}
			</p>

			{result && result.tooLong.length > 0 && (
				<div className="flex flex-col gap-1.5 rounded-md border border-amber-500/20 bg-amber-500/10 p-3">
					<p className="text-xs text-amber-700 dark:text-amber-400">
						{`${result.tooLong.length} cues run over even sped up: shorter text fits.`}
					</p>
					{result.tooLong.map(({ start, text }) => (
						<button
							key={`${start}:${text}`}
							type="button"
							className="truncate text-left text-xs underline-offset-2 hover:underline"
							onClick={() =>
								editor.playback.seek({
									time: mediaTimeFromSeconds({ seconds: start }),
								})
							}
						>
							{`${formatClock({ seconds: start })}  ${text}`}
						</button>
					))}
				</div>
			)}
		</>
	);
}
