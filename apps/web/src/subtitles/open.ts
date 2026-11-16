import {
	openSubtitles,
	type AssStyleData,
	type OpenedSubtitles,
} from "magnetcut-wasm";
import type {
	ParseSubtitleResult,
	SubtitleCue,
	SubtitleStyleOverrides,
} from "./types";

// Subtitle files opened by the Rust core (rust/crates/subtitles): SRT,
// WebVTT, ASS/SSA, SubViewer and MicroDVD, in whatever text encoding, made
// the editor's captions.

/** The files the import offers. */
export const SUBTITLE_FILE_TYPES = ".srt,.vtt,.ass,.ssa,.sub";

const ALIGNMENTS: Record<
	number,
	{
		textAlign: NonNullable<SubtitleStyleOverrides["textAlign"]>;
		verticalAlign: "top" | "middle" | "bottom";
	}
> = {
	1: { textAlign: "left", verticalAlign: "bottom" },
	2: { textAlign: "center", verticalAlign: "bottom" },
	3: { textAlign: "right", verticalAlign: "bottom" },
	4: { textAlign: "left", verticalAlign: "middle" },
	5: { textAlign: "center", verticalAlign: "middle" },
	6: { textAlign: "right", verticalAlign: "middle" },
	7: { textAlign: "left", verticalAlign: "top" },
	8: { textAlign: "center", verticalAlign: "top" },
	9: { textAlign: "right", verticalAlign: "top" },
};

/** "#rrggbbaa" as CSS: opaque as "#rrggbb", else rgba(). */
function cssColor({ color }: { color: string }): {
	css: string;
	alpha: number;
} {
	const [red, green, blue, alpha] = [1, 3, 5, 7].map((at) =>
		Number.parseInt(color.slice(at, at + 2), 16),
	);
	const opacity = alpha / 255;
	return {
		css:
			alpha === 255
				? color.slice(0, 7)
				: `rgba(${red}, ${green}, ${blue}, ${Math.round(opacity * 1000) / 1000})`,
		alpha: opacity,
	};
}

/** An ASS style as the editor's, and whether it uses what it can't draw. */
export function mapAssStyle({
	style,
	playResX,
	playResY,
}: {
	style: AssStyleData;
	playResX: number;
	playResY: number;
}): { style: SubtitleStyleOverrides; hasUnsupportedFeatures: boolean } {
	const alignment = ALIGNMENTS[style.alignment] ?? ALIGNMENTS[2];
	const back = cssColor({ color: style.backColor });
	const isBoxed = style.borderStyle === 3;
	const overrides: SubtitleStyleOverrides = {
		fontFamily: style.fontName,
		// A share of the picture's height, as the script's pixels are.
		...(style.fontSize > 0
			? {
					fontSizeRatioOfPlayHeight:
						Math.round((style.fontSize / playResY) * 1000) / 1000,
				}
			: {}),
		color: cssColor({ color: style.primaryColor }).css,
		fontWeight: style.bold ? "bold" : "normal",
		fontStyle: style.italic ? "italic" : "normal",
		...(style.underline || style.strikeOut
			? { textDecoration: style.underline ? "underline" : "line-through" }
			: {}),
		...(style.spacing !== 0 ? { letterSpacing: style.spacing } : {}),
		textAlign: alignment.textAlign,
		placement: {
			verticalAlign: alignment.verticalAlign,
			marginLeftRatio: style.marginLeft / playResX,
			marginRightRatio: style.marginRight / playResX,
			marginVerticalRatio: style.marginVertical / playResY,
		},
		...(isBoxed
			? {
					background: {
						enabled: back.alpha > 0,
						color: back.alpha > 0 ? back.css : "transparent",
					},
				}
			: {}),
	};
	const hasUnsupportedFeatures =
		(style.borderStyle !== 1 && !isBoxed) ||
		style.outline > 0 ||
		style.shadow > 0 ||
		style.angle !== 0 ||
		style.scaleX !== 100 ||
		style.scaleY !== 100 ||
		(style.underline && style.strikeOut);
	return { style: overrides, hasUnsupportedFeatures };
}

const TAGS = ["i", "b", "u"] as const;
type Tag = (typeof TAGS)[number];

/** A cue's text without markup, and which of italic, bold and underline
 * cover all of it (in one tag, or in one on each line): a caption is styled
 * as a whole. */
function splitMarkup({ text }: { text: string }): {
	text: string;
	whole: Set<Tag>;
	isPartlyStyled: boolean;
} {
	const open = new Set<Tag>();
	const used = new Set<Tag>();
	const covering = new Set<Tag>(TAGS);
	let plain = "";
	for (const part of text.split(/(<\/?[ibu]>)/)) {
		const match = /^<(\/?)([ibu])>$/.exec(part);
		const tag = match && TAGS.find((candidate) => candidate === match[2]);
		if (match && tag) {
			if (match[1]) open.delete(tag);
			else open.add(tag);
			continue;
		}
		plain += part;
		if (!part.trim()) continue;
		for (const candidate of TAGS) {
			if (open.has(candidate)) used.add(candidate);
			else covering.delete(candidate);
		}
	}
	return {
		text: plain.trim(),
		whole: new Set(TAGS.filter((tag) => used.has(tag) && covering.has(tag))),
		isPartlyStyled: [...used].some((tag) => !covering.has(tag)),
	};
}

/** What was opened, as the editor's captions. */
export function toCaptions({
	opened,
}: {
	opened: OpenedSubtitles;
}): ParseSubtitleResult {
	const ass = opened.subtitles.ass;
	const styles = new Map(
		(ass?.styles ?? []).map((style) => [
			style.name,
			mapAssStyle({
				style,
				playResX: ass?.playResX ?? 384,
				playResY: ass?.playResY ?? 288,
			}),
		]),
	);
	const warnings = [...opened.warnings];
	let skippedCueCount = opened.skipped;
	let partlyStyled = 0;
	const captions: SubtitleCue[] = [];
	const cues = opened.subtitles.cues.map((cue) => ({
		cue,
		...splitMarkup({ text: cue.text }),
	}));
	// Subtitles are bold unless a file says otherwise: where it makes some
	// lines bold, the rest aren't, and stay apart from them when saved.
	const hasBoldLines = cues.some(({ whole }) => whole.has("b"));
	for (const { cue, text, whole, isPartlyStyled } of cues) {
		const duration = cue.end - cue.start;
		if (!(duration > 0)) {
			skippedCueCount += 1;
			continue;
		}
		if (isPartlyStyled) partlyStyled += 1;
		const style: SubtitleStyleOverrides = {
			...(hasBoldLines ? { fontWeight: "normal" } : {}),
			...(cue.style ? styles.get(cue.style)?.style : undefined),
			...(whole.has("i") ? { fontStyle: "italic" } : {}),
			...(whole.has("b") ? { fontWeight: "bold" } : {}),
			...(whole.has("u") ? { textDecoration: "underline" } : {}),
		};
		captions.push({
			text,
			startTime: cue.start,
			duration,
			...(Object.keys(style).length > 0 ? { style } : {}),
			...(ass && cue.style ? { assStyle: cue.style } : {}),
		});
	}
	if ([...styles.values()].some((style) => style.hasUnsupportedFeatures)) {
		warnings.push(
			"Some styles use outlines, shadows, rotation or scaling, which captions don't have: they were left out.",
		);
	}
	if (partlyStyled > 0) {
		warnings.push(
			`Italics or bold in part of ${partlyStyled} subtitle(s) were left out: a caption is styled as a whole.`,
		);
	}
	return {
		captions,
		skippedCueCount,
		warnings,
		...(ass ? { assScript: ass } : {}),
	};
}

/** A subtitle file opened as captions. MicroDVD counts frames: at
 * `frameRate`, unless the file says. */
export async function openSubtitleFile({
	file,
	frameRate,
}: {
	file: File;
	frameRate?: number;
}): Promise<ParseSubtitleResult> {
	const bytes = new Uint8Array(await file.arrayBuffer());
	return toCaptions({ opened: openSubtitles(bytes, file.name, frameRate) });
}
