import { useId, type ReactNode } from "react";
import { Cpu, Zap } from "lucide-react";
import {
	RadioGroup as RadioGroupPrimitive,
	ToggleGroup as ToggleGroupPrimitive,
} from "radix-ui";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { EncoderSpeed } from "@/export/hardware";
import { listNames } from "@/utils/string";

// The export panel's own pieces: its modes' switch, the Simple mode's
// destinations, and what the export will make, the same in every mode.

/** A few choices side by side, the chosen one raised: the panel's modes, and
 * Fast mode's two. */
export function SegmentedChoice<T extends string>({
	label,
	value,
	options,
	onChange,
}: {
	label: string;
	value: T;
	options: { value: T; label: string }[];
	onChange: ({ value }: { value: T }) => void;
}) {
	return (
		<ToggleGroupPrimitive.Root
			type="single"
			aria-label={label}
			value={value}
			onValueChange={(next) => {
				// Clicking the chosen one again would choose none: kept.
				const option = options.find((candidate) => candidate.value === next);
				if (option) onChange({ value: option.value });
			}}
			className="bg-muted grid auto-cols-fr grid-flow-col gap-0.5 rounded-lg p-0.5"
		>
			{options.map((option) => (
				<ToggleGroupPrimitive.Item
					key={option.value}
					value={option.value}
					className="text-muted-foreground hover:text-foreground focus-visible:ring-ring data-[state=on]:bg-background data-[state=on]:text-foreground h-7 rounded-md px-2 text-xs font-medium transition-colors focus-visible:ring-1 focus-visible:outline-hidden data-[state=on]:shadow-sm"
				>
					{option.label}
				</ToggleGroupPrimitive.Item>
			))}
		</ToggleGroupPrimitive.Root>
	);
}

/** One of a few, each a card with its icon, name and a line about it. */
export function ChoiceCards<T extends string>({
	label,
	value,
	choices,
	onChange,
}: {
	label: string;
	value: T;
	choices: { value: T; title: string; hint: string; icon: ReactNode }[];
	onChange: ({ value }: { value: T }) => void;
}) {
	return (
		<RadioGroupPrimitive.Root
			aria-label={label}
			value={value}
			onValueChange={(next) => {
				const choice = choices.find((candidate) => candidate.value === next);
				if (choice) onChange({ value: choice.value });
			}}
			className="grid grid-cols-2 gap-2"
		>
			{choices.map((choice) => (
				<RadioGroupPrimitive.Item
					key={choice.value}
					value={choice.value}
					className="group border-border hover:bg-accent/40 focus-visible:ring-ring data-[state=checked]:border-primary data-[state=checked]:bg-primary/10 flex flex-col items-start gap-1 rounded-lg border p-2.5 text-left transition-colors focus-visible:ring-1 focus-visible:outline-hidden"
				>
					<span className="text-muted-foreground group-data-[state=checked]:text-primary [&_svg]:size-4">
						{choice.icon}
					</span>
					<span className="text-sm leading-tight font-medium">
						{choice.title}
					</span>
					<span className="text-muted-foreground text-xs leading-snug">
						{choice.hint}
					</span>
				</RadioGroupPrimitive.Item>
			))}
		</RadioGroupPrimitive.Root>
	);
}

/** What the export will make: the codec, what's in the file, how big, and
 * how it's encoded. */
export function ExportSummary({
	title,
	details,
	size,
	speed,
}: {
	title?: string;
	details: string;
	/** About how big, as it's written ("2.3 GB"): none when it can't be said. */
	size?: string | null;
	/** None when it isn't known, or nothing's encoded. */
	speed?: EncoderSpeed | null;
}) {
	return (
		<div className="flex items-start justify-between gap-4">
			<div className="flex min-w-0 flex-col gap-1">
				{title && <p className="text-sm leading-tight font-medium">{title}</p>}
				<p className="text-muted-foreground text-xs">{details}</p>
				{speed && <EncoderSpeedNote speed={speed} />}
			</div>
			{size && (
				<div className="flex shrink-0 flex-col items-end">
					<span className="text-muted-foreground text-[11px] leading-none">
						about
					</span>
					<span className="text-xl leading-tight font-semibold tabular-nums">
						{size}
					</span>
				</div>
			)}
		</div>
	);
}

function EncoderSpeedNote({ speed }: { speed: EncoderSpeed }) {
	return speed === "hardware" ? (
		<p className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
			<Zap className="size-3.5" aria-hidden />
			Hardware-accelerated
		</p>
	) : (
		<p className="flex items-center gap-1 text-xs text-amber-700 dark:text-amber-300">
			<Cpu className="size-3.5" aria-hidden />
			Encoded in software: much slower
		</p>
	);
}

/** The switch that keeps exports to the codecs encoded in hardware, with what
 * it leaves out (`leftOut`, by name). */
export function HardwareOnlyField({
	checked,
	leftOut,
	onChange,
}: {
	checked: boolean;
	leftOut: string[];
	onChange: ({ checked }: { checked: boolean }) => void;
}) {
	const id = useId();
	const names = listNames({ names: leftOut });
	return (
		<div className="flex flex-col gap-1">
			<div className="flex items-center justify-between gap-3">
				<Label htmlFor={id}>Hardware-accelerated only</Label>
				<Switch
					id={id}
					checked={checked}
					onCheckedChange={(next) => onChange({ checked: next })}
				/>
			</div>
			<p className="text-muted-foreground text-xs">
				{checked
					? `Leaves out ${names}, which this computer encodes in software.`
					: `${names} too: smaller files, but a long film can take hours.`}
			</p>
		</div>
	);
}
