"use client";

import {
	useEffect,
	useRef,
	useState,
	type KeyboardEvent,
	type PointerEvent,
} from "react";
import {
	EQ_BANDS,
	getEqResponse,
	listCurveFrequencies,
	type EqBand,
} from "@/media/eq-curve";
import type { ParamValues } from "@/params";
import { snapToStep } from "@/utils/math";
import { cn } from "@/utils/ui";

/*
 * The Audio tab's controls (docs/AUDIO-EFFECTS.md): a bar for each number,
 * dragged sideways, and the equaliser drawn, its bands points dragged on the
 * curve. Each changes a draft while dragged (`onChange`), written once when
 * let go (`onCommit`): one undo step, and the sound worked out once.
 */

export type Scale = "linear" | "log";

const clamp = ({
	value,
	min,
	max,
}: {
	value: number;
	min: number;
	max: number;
}) => Math.min(max, Math.max(min, value));

function toFraction({
	value,
	min,
	max,
	scale,
}: {
	value: number;
	min: number;
	max: number;
	scale: Scale;
}): number {
	if (max <= min) return 0;
	const clamped = clamp({ value, min, max });
	return scale === "log"
		? Math.log(clamped / min) / Math.log(max / min)
		: (clamped - min) / (max - min);
}

function fromFraction({
	fraction,
	min,
	max,
	scale,
}: {
	fraction: number;
	min: number;
	max: number;
	scale: Scale;
}): number {
	const at = clamp({ value: fraction, min: 0, max: 1 });
	return scale === "log" ? min * (max / min) ** at : min + at * (max - min);
}

const MINUS = "−";

export function formatDb({ value }: { value: number }): string {
	const sign = value > 0 ? "+" : value < 0 ? MINUS : "";
	return `${sign}${Math.abs(value).toFixed(1)} dB`;
}

export function formatHz({ value }: { value: number }): string {
	if (value >= 1000) {
		return `${(value / 1000).toFixed(value >= 10000 ? 1 : 2)} kHz`;
	}
	return `${Math.round(value)} Hz`;
}

export function formatMs({ value }: { value: number }): string {
	if (value >= 1000) return `${(value / 1000).toFixed(2)} s`;
	return `${value < 10 ? value.toFixed(1) : Math.round(value)} ms`;
}

const ARROW_DIRECTIONS: Record<string, number> = {
	ArrowRight: 1,
	ArrowUp: 1,
	ArrowLeft: -1,
	ArrowDown: -1,
};

/**
 * A number as a bar filled to its value (from zero where the range spans
 * it), its name and value written on it: dragged sideways, Shift for finer,
 * the arrow keys a step, a double-click back to the default.
 */
export function SliderBar({
	label,
	value,
	min,
	max,
	step,
	defaultValue,
	scale = "linear",
	format,
	onChange,
	onCommit,
}: {
	label: string;
	value: number;
	min: number;
	max: number;
	step: number;
	defaultValue: number;
	scale?: Scale;
	format: (value: number) => string;
	onChange: (value: number) => void;
	onCommit: () => void;
}) {
	const drag = useRef<{
		pointerId: number;
		startX: number;
		lastX: number;
		fraction: number;
		width: number;
		moved: boolean;
	} | null>(null);
	const fraction = toFraction({ value, min, max, scale });
	const origin =
		min < 0 && max > 0 ? toFraction({ value: 0, min, max, scale }) : 0;

	const set = (next: number) => {
		const snapped = clamp({
			value: snapToStep({ value: next, step }),
			min,
			max,
		});
		if (snapped !== value) onChange(snapped);
	};

	const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
		if (event.button !== 0) return;
		event.currentTarget.setPointerCapture(event.pointerId);
		drag.current = {
			pointerId: event.pointerId,
			startX: event.clientX,
			lastX: event.clientX,
			fraction,
			width: Math.max(1, event.currentTarget.getBoundingClientRect().width),
			moved: false,
		};
	};

	const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
		const current = drag.current;
		if (!current || current.pointerId !== event.pointerId) return;
		if (!current.moved && Math.abs(event.clientX - current.startX) < 3) {
			return;
		}
		current.moved = true;
		const speed = event.shiftKey ? 0.1 : 1;
		current.fraction = clamp({
			value:
				current.fraction +
				((event.clientX - current.lastX) * speed) / current.width,
			min: 0,
			max: 1,
		});
		current.lastX = event.clientX;
		set(fromFraction({ fraction: current.fraction, min, max, scale }));
	};

	const handlePointerEnd = (event: PointerEvent<HTMLDivElement>) => {
		const current = drag.current;
		if (!current || current.pointerId !== event.pointerId) return;
		drag.current = null;
		if (current.moved) onCommit();
	};

	const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const direction = ARROW_DIRECTIONS[event.key];
		if (!direction) return;
		event.preventDefault();
		const next = fromFraction({
			fraction: fraction + direction * (event.shiftKey ? 0.1 : 0.01),
			min,
			max,
			scale,
		});
		const snapped = snapToStep({ value: next, step });
		set(snapped === value ? value + direction * step : snapped);
	};

	const handleKeyUp = (event: KeyboardEvent<HTMLDivElement>) => {
		if (ARROW_DIRECTIONS[event.key]) onCommit();
	};

	return (
		<div
			role="slider"
			tabIndex={0}
			aria-label={label}
			aria-valuemin={min}
			aria-valuemax={max}
			aria-valuenow={value}
			aria-valuetext={format(value)}
			title="Drag sideways (Shift for finer); double-click for the default"
			className="bg-accent focus-visible:ring-ring relative h-7 cursor-ew-resize touch-none overflow-hidden rounded-md text-xs outline-hidden select-none focus-visible:ring-1"
			onPointerDown={handlePointerDown}
			onPointerMove={handlePointerMove}
			onPointerUp={handlePointerEnd}
			onPointerCancel={handlePointerEnd}
			onDoubleClick={() => {
				onChange(defaultValue);
				onCommit();
			}}
			onKeyDown={handleKeyDown}
			onKeyUp={handleKeyUp}
		>
			<div
				className="bg-primary/25 absolute inset-y-0"
				style={{
					left: `${Math.min(origin, fraction) * 100}%`,
					width: `${Math.abs(fraction - origin) * 100}%`,
				}}
			/>
			{origin > 0 && (
				<div
					className="bg-foreground/25 absolute inset-y-1.5 w-px"
					style={{ left: `${origin * 100}%` }}
				/>
			)}
			<div
				className="bg-primary absolute inset-y-0 w-0.5"
				style={{ left: `calc(${fraction * 100}% - ${fraction * 2}px)` }}
			/>
			<div className="relative flex h-full items-center justify-between gap-2 px-2.5">
				<span className="truncate">{label}</span>
				<span
					className={cn(
						"shrink-0 tabular-nums",
						value === defaultValue ? "text-muted-foreground" : "font-medium",
					)}
				>
					{format(value)}
				</span>
			</div>
		</div>
	);
}

/** A choice of a few, side by side. */
export function SegmentedControl({
	label,
	value,
	options,
	onChange,
}: {
	label: string;
	value: string;
	options: { value: string; label: string; title?: string }[];
	onChange: (value: string) => void;
}) {
	return (
		<div className="flex items-center justify-between gap-2 text-xs">
			<span className="truncate">{label}</span>
			<div
				role="radiogroup"
				aria-label={label}
				className="bg-accent flex shrink-0 rounded-md p-0.5"
			>
				{options.map((option) => {
					const isChosen = option.value === value;
					return (
						<button
							key={option.value}
							type="button"
							role="radio"
							aria-checked={isChosen}
							title={option.title}
							className={cn(
								"focus-visible:ring-ring h-6 rounded-[5px] px-2 outline-hidden focus-visible:ring-1",
								isChosen
									? "bg-background font-medium shadow-sm"
									: "text-muted-foreground hover:text-foreground",
							)}
							onClick={() => onChange(option.value)}
						>
							{option.label}
						</button>
					);
				})}
			</div>
		</div>
	);
}

const FREQUENCY_MIN = 20;
const FREQUENCY_MAX = 20000;
const GAIN_RANGE = 24;
const GAIN_STEP = 0.5;
const Q_MIN = 0.1;
const Q_MAX = 10;
const VIEW_WIDTH = 1000;
const VIEW_HEIGHT = 400;
const CURVE_FREQUENCIES = listCurveFrequencies({ count: 200 });
const GRID_FREQUENCIES = [50, 100, 200, 500, 1000, 2000, 5000, 10000];
const FREQUENCY_LABELS = [
	{ frequency: 100, label: "100" },
	{ frequency: 1000, label: "1k" },
	{ frequency: 10000, label: "10k" },
];
const GRID_GAINS = [-18, -12, -6, 6, 12, 18];
const GAIN_LABELS = [12, 0, -12];
// How long the wheel rests before a width it changed is written.
const WHEEL_COMMIT_MS = 400;

const frequencyToX = (frequency: number) =>
	toFraction({
		value: frequency,
		min: FREQUENCY_MIN,
		max: FREQUENCY_MAX,
		scale: "log",
	});
const gainToY = (gain: number) =>
	(GAIN_RANGE - clamp({ value: gain, min: -GAIN_RANGE, max: GAIN_RANGE })) /
	(2 * GAIN_RANGE);

function readBand({ params, band }: { params: ParamValues; band: EqBand }): {
	gain: number;
	frequency: number;
	q: number;
} {
	const number = ({ key, fallback }: { key: string; fallback: number }) => {
		const value = params[`${band.prefix}${key}`];
		return typeof value === "number" && Number.isFinite(value)
			? value
			: fallback;
	};
	return {
		gain: number({ key: "Gain", fallback: 0 }),
		frequency: number({ key: "Frequency", fallback: band.frequency }),
		q: number({ key: "Q", fallback: 1 }),
	};
}

function toPoints({ response }: { response: number[] }): string {
	return response
		.map(
			(db, index) =>
				`${((index / (response.length - 1)) * VIEW_WIDTH).toFixed(1)},${(gainToY(db) * VIEW_HEIGHT).toFixed(1)}`,
		)
		.join(" ");
}

/**
 * The equaliser drawn, 20 Hz to 20 kHz across and ±24 dB up and down, its
 * five bands points on it: dragged sideways for the frequency and up and down
 * for the gain, the wheel on a mid one for its width, a double-click to
 * flatten it. The chosen band's numbers are under it.
 */
export function EqEditor({
	params,
	onChange,
	onCommit,
}: {
	params: ParamValues;
	onChange: (values: ParamValues) => void;
	onCommit: () => void;
}) {
	const graphRef = useRef<HTMLDivElement>(null);
	const [selected, setSelected] = useState<EqBand["prefix"]>("eqMid2");
	const drag = useRef<{
		pointerId: number;
		band: EqBand;
		offsetX: number;
		offsetY: number;
		moved: boolean;
	} | null>(null);
	const latest = useRef({ params, onChange, onCommit });
	useEffect(() => {
		latest.current = { params, onChange, onCommit };
	});

	const selectedBand =
		EQ_BANDS.find(({ prefix }) => prefix === selected) ?? EQ_BANDS[2];
	const selectedValues = readBand({ params, band: selectedBand });
	const curve = toPoints({
		response: getEqResponse({ params, frequencies: CURVE_FREQUENCIES }),
	});
	const zeroY = gainToY(0) * VIEW_HEIGHT;
	const fill = `0,${zeroY} ${curve} ${VIEW_WIDTH},${zeroY}`;
	const selectedCurve =
		Math.abs(selectedValues.gain) >= 0.01
			? toPoints({
					response: getEqResponse({
						params,
						frequencies: CURVE_FREQUENCIES,
						only: selectedBand.prefix,
					}),
				})
			: null;

	// The wheel on a mid band's point widens or narrows it. Not React's
	// onWheel, which can't keep the panel from scrolling.
	useEffect(() => {
		const node = graphRef.current;
		if (!node) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		// The width as the wheel has it, unrounded: events come faster than
		// renders, and a trackpad's are too small to change it rounded each.
		let pending: { prefix: string; q: number } | null = null;
		const handleWheel = (event: WheelEvent) => {
			const target =
				event.target instanceof Element
					? event.target.closest<HTMLElement>("[data-band]")
					: null;
			const band = EQ_BANDS.find(
				({ prefix }) => prefix === target?.dataset.band,
			);
			if (!band || band.kind !== "peak") return;
			event.preventDefault();
			const q =
				pending?.prefix === band.prefix
					? pending.q
					: readBand({ params: latest.current.params, band }).q;
			const next = clamp({
				value: q * Math.exp(-event.deltaY * 0.002),
				min: Q_MIN,
				max: Q_MAX,
			});
			pending = { prefix: band.prefix, q: next };
			setSelected(band.prefix);
			latest.current.onChange({
				[`${band.prefix}Q`]: snapToStep({ value: next, step: 0.01 }),
			});
			clearTimeout(timer);
			timer = setTimeout(() => {
				timer = undefined;
				pending = null;
				latest.current.onCommit();
			}, WHEEL_COMMIT_MS);
		};
		node.addEventListener("wheel", handleWheel, { passive: false });
		return () => {
			node.removeEventListener("wheel", handleWheel);
			if (timer !== undefined) {
				clearTimeout(timer);
				latest.current.onCommit();
			}
		};
	}, []);

	const resetBand = (band: EqBand) => {
		onChange({
			[`${band.prefix}Gain`]: 0,
			[`${band.prefix}Frequency`]: band.frequency,
			...(band.kind === "peak" ? { [`${band.prefix}Q`]: 1 } : {}),
		});
		onCommit();
	};

	const handlePointerDown = ({
		event,
		band,
	}: {
		event: PointerEvent<HTMLButtonElement>;
		band: EqBand;
	}) => {
		const rect = graphRef.current?.getBoundingClientRect();
		if (event.button !== 0 || !rect) return;
		setSelected(band.prefix);
		const { gain, frequency } = readBand({ params, band });
		event.currentTarget.setPointerCapture(event.pointerId);
		drag.current = {
			pointerId: event.pointerId,
			band,
			offsetX:
				event.clientX - (rect.left + frequencyToX(frequency) * rect.width),
			offsetY: event.clientY - (rect.top + gainToY(gain) * rect.height),
			moved: false,
		};
	};

	const handlePointerMove = (event: PointerEvent<HTMLButtonElement>) => {
		const current = drag.current;
		const rect = graphRef.current?.getBoundingClientRect();
		if (!current || current.pointerId !== event.pointerId || !rect) return;
		current.moved = true;
		const x = (event.clientX - current.offsetX - rect.left) / rect.width;
		const y = (event.clientY - current.offsetY - rect.top) / rect.height;
		const gain = clamp({
			value: snapToStep({
				value: GAIN_RANGE - y * 2 * GAIN_RANGE,
				step: GAIN_STEP,
			}),
			min: -GAIN_RANGE,
			max: GAIN_RANGE,
		});
		const frequency = Math.round(
			fromFraction({
				fraction: x,
				min: FREQUENCY_MIN,
				max: FREQUENCY_MAX,
				scale: "log",
			}),
		);
		const { prefix } = current.band;
		onChange({
			[`${prefix}Gain`]: gain,
			// Shift holds the frequency: the gain alone.
			...(event.shiftKey ? {} : { [`${prefix}Frequency`]: frequency }),
		});
	};

	const handlePointerEnd = (event: PointerEvent<HTMLButtonElement>) => {
		const current = drag.current;
		if (!current || current.pointerId !== event.pointerId) return;
		drag.current = null;
		if (current.moved) onCommit();
	};

	const handleKeyDown = ({
		event,
		band,
	}: {
		event: KeyboardEvent<HTMLButtonElement>;
		band: EqBand;
	}) => {
		const { gain, frequency } = readBand({ params, band });
		const coarse = event.shiftKey;
		if (event.key === "ArrowUp" || event.key === "ArrowDown") {
			event.preventDefault();
			const direction = event.key === "ArrowUp" ? 1 : -1;
			onChange({
				[`${band.prefix}Gain`]: clamp({
					value: gain + direction * (coarse ? 3 : GAIN_STEP),
					min: -GAIN_RANGE,
					max: GAIN_RANGE,
				}),
			});
		} else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
			event.preventDefault();
			const direction = event.key === "ArrowRight" ? 1 : -1;
			onChange({
				[`${band.prefix}Frequency`]: Math.round(
					clamp({
						value: frequency * 2 ** ((direction * (coarse ? 4 : 1)) / 12),
						min: FREQUENCY_MIN,
						max: FREQUENCY_MAX,
					}),
				),
			});
		}
	};

	const handleKeyUp = (event: KeyboardEvent<HTMLButtonElement>) => {
		if (ARROW_DIRECTIONS[event.key]) onCommit();
	};

	return (
		<div className="flex flex-col gap-1.5">
			<div
				ref={graphRef}
				className="bg-muted/40 relative h-36 touch-none rounded-md border select-none"
			>
				<svg
					viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
					preserveAspectRatio="none"
					className="absolute inset-0 size-full overflow-hidden rounded-md"
					aria-hidden
				>
					{GRID_FREQUENCIES.map((frequency) => (
						<line
							key={frequency}
							x1={frequencyToX(frequency) * VIEW_WIDTH}
							x2={frequencyToX(frequency) * VIEW_WIDTH}
							y1={0}
							y2={VIEW_HEIGHT}
							className="stroke-border"
							vectorEffect="non-scaling-stroke"
						/>
					))}
					{GRID_GAINS.map((gain) => (
						<line
							key={gain}
							x1={0}
							x2={VIEW_WIDTH}
							y1={gainToY(gain) * VIEW_HEIGHT}
							y2={gainToY(gain) * VIEW_HEIGHT}
							className="stroke-border"
							vectorEffect="non-scaling-stroke"
						/>
					))}
					<line
						x1={0}
						x2={VIEW_WIDTH}
						y1={zeroY}
						y2={zeroY}
						className="stroke-muted-foreground/60"
						strokeDasharray="4 4"
						vectorEffect="non-scaling-stroke"
					/>
					<polygon points={fill} className="fill-primary/15" />
					{selectedCurve && (
						<polyline
							points={selectedCurve}
							fill="none"
							className="stroke-primary/50"
							strokeWidth={1}
							vectorEffect="non-scaling-stroke"
						/>
					)}
					<polyline
						points={curve}
						fill="none"
						className="stroke-primary"
						strokeWidth={2}
						vectorEffect="non-scaling-stroke"
					/>
				</svg>
				{FREQUENCY_LABELS.map(({ frequency, label }) => (
					<span
						key={frequency}
						className="text-muted-foreground pointer-events-none absolute bottom-0.5 ml-1 text-[0.6rem]"
						style={{ left: `${frequencyToX(frequency) * 100}%` }}
					>
						{label}
					</span>
				))}
				{GAIN_LABELS.map((gain) => (
					<span
						key={gain}
						className="text-muted-foreground pointer-events-none absolute left-1 -translate-y-full text-[0.6rem]"
						style={{ top: `${gainToY(gain) * 100}%` }}
					>
						{gain > 0 ? `+${gain}` : gain < 0 ? `${MINUS}${-gain}` : "0 dB"}
					</span>
				))}
				{EQ_BANDS.map((band, index) => {
					const { gain, frequency } = readBand({ params, band });
					const isSelected = band.prefix === selected;
					return (
						<button
							key={band.prefix}
							type="button"
							data-band={band.prefix}
							aria-label={`${band.name}: ${formatHz({ value: frequency })}, ${formatDb({ value: gain })}`}
							title={`${band.name}: drag it; double-click to flatten it${band.kind === "peak" ? "; the wheel for its width" : ""}`}
							className={cn(
								"focus-visible:ring-ring absolute flex size-4 -translate-x-1/2 -translate-y-1/2 cursor-grab touch-none items-center justify-center rounded-full border text-[0.6rem] leading-none font-semibold outline-hidden focus-visible:ring-2 active:cursor-grabbing",
								isSelected
									? "bg-primary text-primary-foreground border-primary z-10"
									: "bg-background text-foreground border-foreground/40",
							)}
							style={{
								left: `${frequencyToX(frequency) * 100}%`,
								top: `${gainToY(gain) * 100}%`,
							}}
							onPointerDown={(event) => handlePointerDown({ event, band })}
							onPointerMove={handlePointerMove}
							onPointerUp={handlePointerEnd}
							onPointerCancel={handlePointerEnd}
							onDoubleClick={() => resetBand(band)}
							onFocus={() => setSelected(band.prefix)}
							onKeyDown={(event) => handleKeyDown({ event, band })}
							onKeyUp={handleKeyUp}
						>
							{index + 1}
						</button>
					);
				})}
			</div>
			<p className="text-xs font-medium">{selectedBand.name}</p>
			<SliderBar
				label="Frequency"
				value={selectedValues.frequency}
				min={FREQUENCY_MIN}
				max={FREQUENCY_MAX}
				step={1}
				defaultValue={selectedBand.frequency}
				scale="log"
				format={(value) => formatHz({ value })}
				onChange={(value) =>
					onChange({ [`${selectedBand.prefix}Frequency`]: value })
				}
				onCommit={onCommit}
			/>
			<SliderBar
				label="Gain"
				value={selectedValues.gain}
				min={-GAIN_RANGE}
				max={GAIN_RANGE}
				step={GAIN_STEP}
				defaultValue={0}
				format={(value) => formatDb({ value })}
				onChange={(value) =>
					onChange({ [`${selectedBand.prefix}Gain`]: value })
				}
				onCommit={onCommit}
			/>
			{selectedBand.kind === "peak" && (
				<SliderBar
					label="Width (Q)"
					value={selectedValues.q}
					min={Q_MIN}
					max={Q_MAX}
					step={0.01}
					defaultValue={1}
					scale="log"
					format={(value) => value.toFixed(2)}
					onChange={(value) => onChange({ [`${selectedBand.prefix}Q`]: value })}
					onCommit={onCommit}
				/>
			)}
		</div>
	);
}

const COMPRESSOR_FLOOR = -80;

/**
 * The compressor's curve: the level in across, out up, from −80 to 0 dB,
 * bent at the threshold by the ratio and lifted by the makeup gain.
 */
export function CompressorGraph({
	threshold,
	ratio,
	makeup,
}: {
	threshold: number;
	ratio: number;
	makeup: number;
}) {
	const toX = (db: number) =>
		((db - COMPRESSOR_FLOOR) / -COMPRESSOR_FLOOR) * 100;
	const toY = (db: number) =>
		100 - ((db - COMPRESSOR_FLOOR) / -COMPRESSOR_FLOOR) * 100;
	const out = (input: number) =>
		(input < threshold ? input : threshold + (input - threshold) / ratio) +
		makeup;
	const points = [COMPRESSOR_FLOOR, threshold, 0]
		.map((input) => `${toX(input)},${toY(out(input))}`)
		.join(" ");
	return (
		<svg
			viewBox="0 0 100 100"
			className="bg-muted/40 size-full overflow-hidden rounded-md border"
			role="img"
			aria-label={`The compressor's curve: above ${formatDb({ value: threshold })}, ${ratio.toFixed(1)} to 1`}
		>
			<line
				x1={0}
				y1={100}
				x2={100}
				y2={0}
				className="stroke-muted-foreground/50"
				strokeDasharray="3 3"
				vectorEffect="non-scaling-stroke"
			/>
			<line
				x1={toX(threshold)}
				x2={toX(threshold)}
				y1={0}
				y2={100}
				className="stroke-border"
				vectorEffect="non-scaling-stroke"
			/>
			<polyline
				points={points}
				fill="none"
				className="stroke-primary"
				strokeWidth={2}
				vectorEffect="non-scaling-stroke"
			/>
			<circle
				cx={toX(threshold)}
				cy={toY(out(threshold))}
				r={3}
				className="fill-primary"
			/>
		</svg>
	);
}
