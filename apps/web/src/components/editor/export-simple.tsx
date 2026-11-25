import { useEffect, useState, type ReactNode } from "react";
import { Clapperboard, Feather, MonitorSmartphone, Upload } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import type { ExportChoices } from "@/export/choices";
import {
	getHardwareCodecs,
	keepToHardware,
	useHardwareOnlyStore,
} from "@/export/hardware";
import type { NativeCapabilities } from "@/export/native";
import {
	FRAME_RATE_PRESETS,
	SIZE_PRESETS,
	fitExportSize,
} from "@/export/settings";
import {
	DESTINATIONS,
	SOUND_CHOICES,
	SOUND_NAMES,
	applyWizardAnswers,
	getAskedShortSide,
	getDestinationLimits,
	getWizardFormat,
	type Destination,
	type WizardAnswers,
} from "@/export/wizard";
import { frameRateToFloat } from "@/fps/utils";
import { ChoiceCards } from "./export-parts";
import { getCodecsKey, useEncodableCodecs } from "./use-export-codecs";

// The export panel's Simple mode: what it's for, how big it may be, how
// sharp and smooth, and the sound, in everyday words; the Advanced mode's
// settings follow from the answers (`export/wizard.ts`), and the panel's
// summary says what they make.

// Email's: Outlook.com and iCloud Mail take 20 MB, Gmail 25.
const SIZE_LIMITS = [
	{ megabytes: 10, label: "10 MB (Discord)" },
	{ megabytes: 20, label: "20 MB (email)" },
	{ megabytes: 50, label: "50 MB" },
	{ megabytes: 100, label: "100 MB" },
];

const DESTINATION_CARDS: Record<
	Destination,
	{ title: string; hint: string; icon: ReactNode }
> = {
	anything: {
		title: "Any device",
		hint: "Old players too, up to 1080p",
		icon: <MonitorSmartphone />,
	},
	upload: {
		title: "Online",
		hint: "YouTube, TikTok, Instagram",
		icon: <Upload />,
	},
	small: {
		title: "Smallest file",
		hint: "For devices of recent years",
		icon: <Feather />,
	},
	master: {
		title: "Master file",
		hint: "To keep, or edit elsewhere",
		icon: <Clapperboard />,
	},
};

/** A question on the left, its answer on the right. */
function Row({
	label,
	htmlFor,
	children,
}: {
	label: string;
	htmlFor?: string;
	children: ReactNode;
}) {
	return (
		<div className="flex items-center justify-between gap-3">
			<Label htmlFor={htmlFor} className="text-muted-foreground font-normal">
				{label}
			</Label>
			{children}
		</div>
	);
}

const TRIGGER = "w-48";

export function ExportSimple({
	choices,
	setChoices,
	native,
	picture,
	projectFps,
	duration,
	copiedBitrate,
}: {
	choices: ExportChoices;
	setChoices: ({ choices }: { choices: Partial<ExportChoices> }) => void;
	/** What the desktop app's own export does here: none where there's none. */
	native: NativeCapabilities | null;
	/** The picture's size, after any crop. */
	picture: { width: number; height: number };
	projectFps: number;
	/** The film's length, in seconds. */
	duration: number;
	/** The source's sound's, where it can be copied (`applyWizardAnswers`). */
	copiedBitrate: number | null;
}) {
	const answers = choices.wizard;
	const pictureShortSide = Math.min(picture.width, picture.height);
	const limits = getDestinationLimits({ destination: answers.destination });
	const isPresetSize =
		answers.maxMegabytes === null ||
		SIZE_LIMITS.some(({ megabytes }) => megabytes === answers.maxMegabytes);
	const [isCustomSize, setIsCustomSize] = useState(!isPresetSize);

	// The codecs to choose from, in the destination's container at the size
	// asked: those encoded in hardware, while exports keep to them.
	const format = getWizardFormat({ destination: answers.destination });
	const asked = fitExportSize({
		canvas: picture,
		shortSide: getAskedShortSide({ answers, pictureShortSide }),
	});
	const allEncodable = useEncodableCodecs({ ...asked, format });
	const hardwareOnly = useHardwareOnlyStore((state) => state.hardwareOnly);
	const encodable = keepToHardware({
		encodable: allEncodable,
		hardware: getHardwareCodecs({ native, format }),
		hardwareOnly,
	});

	const answer = ({ patch }: { patch: Partial<WizardAnswers> }) => {
		const next = { ...answers, ...patch };
		setChoices({
			choices: {
				...applyWizardAnswers({
					answers: next,
					choices,
					encodable,
					projectFps,
					picture,
					duration,
					copiedBitrate,
				}),
				wizard: next,
			},
		});
	};

	// The answers made settings when the mode opens, and again once what this
	// computer encodes is known, or which codecs are offered changes; not on
	// every change of the choices, which the answers themselves make.
	const encodableKey = getCodecsKey({ codecs: encodable });
	useEffect(() => {
		answer({ patch: {} });
		// eslint-disable-next-line react-hooks/exhaustive-deps -- see above
	}, [
		encodableKey,
		picture.width,
		picture.height,
		projectFps,
		duration,
		copiedBitrate,
	]);

	const fpsChoices = FRAME_RATE_PRESETS.filter(
		({ rate }) => frameRateToFloat(rate) < projectFps - 0.01,
	);

	return (
		<div className="flex flex-col gap-5 px-4 py-4">
			<div className="flex flex-col gap-2">
				<Label>Where will it be watched?</Label>
				<ChoiceCards
					label="Where will it be watched?"
					value={answers.destination}
					choices={DESTINATIONS.map((destination) => ({
						value: destination,
						...DESTINATION_CARDS[destination],
					}))}
					onChange={({ value }) => answer({ patch: { destination: value } })}
				/>
			</div>

			<div className="flex flex-col gap-2.5">
				<Row label="Size limit">
					<Select
						value={
							isCustomSize
								? "custom"
								: answers.maxMegabytes === null
									? "none"
									: String(answers.maxMegabytes)
						}
						onValueChange={(value) => {
							setIsCustomSize(value === "custom");
							if (value === "custom") {
								answer({ patch: { maxMegabytes: answers.maxMegabytes ?? 50 } });
								return;
							}
							answer({
								patch: {
									maxMegabytes: value === "none" ? null : Number(value),
								},
							});
						}}
					>
						<SelectTrigger variant="outline" className={TRIGGER}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent position="popper">
							<SelectItem value="none">No limit</SelectItem>
							{SIZE_LIMITS.map(({ megabytes, label }) => (
								<SelectItem key={megabytes} value={String(megabytes)}>
									{label}
								</SelectItem>
							))}
							<SelectItem value="custom">Your own</SelectItem>
						</SelectContent>
					</Select>
				</Row>
				{isCustomSize && (
					<Row label="Largest, in MB" htmlFor="export-largest-size">
						<Input
							id="export-largest-size"
							type="number"
							min={1}
							className={TRIGGER}
							value={answers.maxMegabytes ?? ""}
							onChange={(event) => {
								const value = Number(event.target.value);
								if (value > 0) answer({ patch: { maxMegabytes: value } });
							}}
						/>
					</Row>
				)}

				<Row label="Sharpness">
					<Select
						value={
							answers.shortSide === null ? "full" : String(answers.shortSide)
						}
						onValueChange={(value) =>
							answer({
								patch: { shortSide: value === "full" ? null : Number(value) },
							})
						}
					>
						<SelectTrigger variant="outline" className={TRIGGER}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent position="popper">
							<SelectItem value="full">
								{`${picture.width}×${picture.height}, as made`}
							</SelectItem>
							{/* Never bigger than it was made: that adds size, not detail. */}
							{SIZE_PRESETS.filter(
								(preset) => preset.shortSide < pictureShortSide,
							).map((preset) => {
								const isTooBig =
									!!limits.shortSide && preset.shortSide > limits.shortSide;
								return (
									<SelectItem
										key={preset.shortSide}
										value={String(preset.shortSide)}
										disabled={isTooBig}
									>
										{preset.label}
										{isTooBig ? " (too big for old players)" : ""}
									</SelectItem>
								);
							})}
						</SelectContent>
					</Select>
				</Row>

				<Row label="Smoothness">
					<Select
						value={answers.fpsLabel ?? "same"}
						onValueChange={(value) =>
							answer({ patch: { fpsLabel: value === "same" ? null : value } })
						}
					>
						<SelectTrigger variant="outline" className={TRIGGER}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent position="popper">
							<SelectItem value="same">
								{`${+projectFps.toFixed(3)} fps, as made`}
							</SelectItem>
							{fpsChoices.map((preset) => {
								const isTooFast =
									!!limits.fps &&
									frameRateToFloat(preset.rate) > limits.fps + 0.01;
								return (
									<SelectItem
										key={preset.label}
										value={preset.label}
										disabled={isTooFast}
									>
										{`${preset.label} fps`}
										{isTooFast ? " (too fast for old players)" : ""}
									</SelectItem>
								);
							})}
						</SelectContent>
					</Select>
				</Row>

				<Row label="Sound">
					<Select
						value={answers.sound}
						onValueChange={(value) => {
							const sound = SOUND_CHOICES.find(
								(candidate) => candidate === value,
							);
							if (sound) answer({ patch: { sound } });
						}}
					>
						<SelectTrigger variant="outline" className={TRIGGER}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent position="popper">
							{SOUND_CHOICES.map((sound) => (
								<SelectItem key={sound} value={sound}>
									{SOUND_NAMES[sound]}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</Row>
			</div>
		</div>
	);
}
