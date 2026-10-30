import { useEffect, useState } from "react";
import { SectionField } from "@/components/section";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import type { ExportChoices } from "@/export/choices";
import {
	FRAME_RATE_PRESETS,
	SIZE_PRESETS,
	type ExportVideoCodec,
} from "@/export/settings";
import {
	DESTINATIONS,
	DESTINATION_HINTS,
	DESTINATION_NAMES,
	SOUND_CHOICES,
	SOUND_NAMES,
	applyWizardAnswers,
	getDestinationLimits,
	type WizardAnswers,
} from "@/export/wizard";
import { frameRateToFloat } from "@/fps/utils";

// The export panel's Simple mode: what it's for, how big it may be, how
// sharp and smooth, and the sound, in everyday words; the Advanced mode's
// settings follow from the answers (`export/wizard.ts`).

const SIZE_LIMITS = [
	{ megabytes: 10, label: "10 MB (Discord)" },
	{ megabytes: 25, label: "25 MB (email)" },
	{ megabytes: 50, label: "50 MB" },
	{ megabytes: 100, label: "100 MB" },
];

export function ExportSimple({
	choices,
	setChoices,
	encodable,
	picture,
	projectFps,
}: {
	choices: ExportChoices;
	setChoices: ({ choices }: { choices: Partial<ExportChoices> }) => void;
	/** What this computer encodes: none until it's known. */
	encodable: Set<ExportVideoCodec> | null;
	/** The picture's size, after any crop. */
	picture: { width: number; height: number };
	projectFps: number;
}) {
	const answers = choices.wizard;
	const pictureShortSide = Math.min(picture.width, picture.height);
	const limits = getDestinationLimits({ destination: answers.destination });
	const isPresetSize =
		answers.maxMegabytes === null ||
		SIZE_LIMITS.some(({ megabytes }) => megabytes === answers.maxMegabytes);
	const [isCustomSize, setIsCustomSize] = useState(!isPresetSize);

	const answer = ({ patch }: { patch: Partial<WizardAnswers> }) => {
		const next = { ...answers, ...patch };
		setChoices({
			choices: {
				...applyWizardAnswers({
					answers: next,
					choices,
					encodable,
					projectShortSide: pictureShortSide,
					projectFps,
				}),
				wizard: next,
			},
		});
	};

	// The answers made settings when the mode opens, and again once what this
	// computer encodes is known; not on every change of the choices, which the
	// answers themselves make.
	useEffect(() => {
		answer({ patch: {} });
		// eslint-disable-next-line react-hooks/exhaustive-deps -- see above
	}, [encodable, pictureShortSide, projectFps]);

	const fpsChoices = FRAME_RATE_PRESETS.filter(
		({ rate }) => frameRateToFloat(rate) < projectFps - 0.01,
	);

	return (
		<div className="flex flex-col gap-4 p-3">
			<div className="flex flex-col gap-2">
				<Label>Where will it be watched?</Label>
				<RadioGroup
					value={answers.destination}
					onValueChange={(value) => {
						const destination = DESTINATIONS.find(
							(candidate) => candidate === value,
						);
						if (destination) answer({ patch: { destination } });
					}}
				>
					{DESTINATIONS.map((destination) => (
						<div key={destination} className="flex items-start space-x-2">
							<RadioGroupItem
								value={destination}
								id={`destination-${destination}`}
								className="mt-0.5"
							/>
							<Label
								htmlFor={`destination-${destination}`}
								className="flex flex-col items-start gap-0.5"
							>
								<span>{DESTINATION_NAMES[destination]}</span>
								<span className="text-muted-foreground text-xs font-normal">
									{DESTINATION_HINTS[destination]}
								</span>
							</Label>
						</div>
					))}
				</RadioGroup>
			</div>

			<SectionField label="How big can the file be?">
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
							patch: { maxMegabytes: value === "none" ? null : Number(value) },
						});
					}}
				>
					<SelectTrigger variant="outline">
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
				{isCustomSize && (
					<Input
						type="number"
						min={1}
						aria-label="Largest file size, in MB"
						value={answers.maxMegabytes ?? ""}
						onChange={(event) => {
							const value = Number(event.target.value);
							if (value > 0) answer({ patch: { maxMegabytes: value } });
						}}
					/>
				)}
			</SectionField>

			<SectionField label="How sharp?">
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
					<SelectTrigger variant="outline">
						<SelectValue />
					</SelectTrigger>
					<SelectContent position="popper">
						<SelectItem value="full">
							{`As it was made (${picture.width}×${picture.height})`}
						</SelectItem>
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
				<p className="text-muted-foreground text-xs">
					Never made bigger than it was made: that would add size, not detail.
				</p>
			</SectionField>

			<SectionField label="How smooth?">
				<Select
					value={answers.fpsLabel ?? "same"}
					onValueChange={(value) =>
						answer({ patch: { fpsLabel: value === "same" ? null : value } })
					}
				>
					<SelectTrigger variant="outline">
						<SelectValue />
					</SelectTrigger>
					<SelectContent position="popper">
						<SelectItem value="same">
							{`As it was made (${+projectFps.toFixed(3)} frames a second)`}
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
									{`${preset.label} frames a second`}
									{isTooFast ? " (too fast for old players)" : ""}
								</SelectItem>
							);
						})}
					</SelectContent>
				</Select>
			</SectionField>

			<SectionField label="Sound">
				<Select
					value={answers.sound}
					onValueChange={(value) => {
						const sound = SOUND_CHOICES.find(
							(candidate) => candidate === value,
						);
						if (sound) answer({ patch: { sound } });
					}}
				>
					<SelectTrigger variant="outline">
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
			</SectionField>
		</div>
	);
}
