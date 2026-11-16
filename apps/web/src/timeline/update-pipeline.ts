import { clampAnimationsToDuration } from "@/animation";
import {
	clampRetimeRate,
	getSourceSpanAtClipTime,
	getTimelineDurationForSourceSpan,
} from "@/retime";
import type { RetimeConfig, SceneTracks, TimelineElement } from "@/timeline";
import { isRetimableElement } from "@/timeline";
import { findTrackInSceneTracks } from "@/timeline/track-element-update";
import { ZERO_MEDIA_TIME, mediaTime, roundMediaTime } from "@/wasm";

type ElementUpdateField = keyof TimelineElement | string;

export interface ElementUpdateContext {
	tracks: SceneTracks;
	trackId: string;
}

interface ElementUpdateRuleResult {
	element: TimelineElement;
	changedFields?: ElementUpdateField[];
}

interface ElementUpdateRuleParams {
	element: TimelineElement;
	originalElement: TimelineElement;
	patch: Partial<TimelineElement>;
	context: ElementUpdateContext;
}

interface ElementUpdateRule {
	triggers: ElementUpdateField[];
	apply: (params: ElementUpdateRuleParams) => ElementUpdateRuleResult;
}

const deriveRules: ElementUpdateRule[] = [
	{
		triggers: ["retime"],
		apply: ({ element, originalElement, patch, context }) => {
			if (!("retime" in patch) || !isRetimableElement(element)) {
				return { element };
			}

			const nextRetime = patch.retime
				? {
						...patch.retime,
						rate: clampRetimeRate({ rate: patch.retime.rate }),
					}
				: undefined;

			const sourceDuration = getSourceDuration({
				trimStart: originalElement.trimStart,
				trimEnd: originalElement.trimEnd,
				duration: originalElement.duration,
				sourceDuration: isRetimableElement(originalElement)
					? originalElement.sourceDuration
					: undefined,
				retime: isRetimableElement(originalElement)
					? originalElement.retime
					: undefined,
			});
			const visibleSourceSpan = Math.max(
				0,
				sourceDuration - element.trimStart - element.trimEnd,
			);
			const nextDuration = roundMediaTime({
				time: getTimelineDurationForSourceSpan({
					sourceSpan: visibleSourceSpan,
					retime: nextRetime,
				}),
			});

			// Slowed down, it stops where the next clip on its track starts,
			// the rest of its media past its end, as a trim leaves it.
			const room = getRoomOnTrack({ element: originalElement, context });
			if (nextDuration > room) {
				const shownSourceSpan = roundMediaTime({
					time: getSourceSpanAtClipTime({
						clipTime: room,
						retime: nextRetime,
					}),
				});
				return {
					element: {
						...element,
						retime: nextRetime,
						duration: mediaTime({ ticks: room }),
						trimEnd: mediaTime({
							ticks: Math.max(
								0,
								sourceDuration - element.trimStart - shownSourceSpan,
							),
						}),
					},
					changedFields: ["retime", "duration", "trimEnd"],
				};
			}

			return {
				element: {
					...element,
					retime: nextRetime,
					duration: nextDuration,
				},
				changedFields: ["retime", "duration"],
			};
		},
	},
];

const enforceRules: ElementUpdateRule[] = [
	{
		triggers: ["duration"],
		apply: ({ element }) => ({
			element: {
				...element,
				animations: clampAnimationsToDuration({
					animations: element.animations,
					duration: element.duration,
				}),
			},
		}),
	},
	{
		triggers: ["startTime"],
		apply: ({ element, context }) => {
			const requestedStartTime =
				element.startTime < ZERO_MEDIA_TIME
					? ZERO_MEDIA_TIME
					: element.startTime;
			if (context.trackId !== context.tracks.main.id) {
				return {
					element: {
						...element,
						startTime: requestedStartTime,
					},
				};
			}

			const earliestElement = context.tracks.main.elements
				.filter((candidate) => candidate.id !== element.id)
				.reduce<TimelineElement | null>((earliest, candidate) => {
					if (!earliest || candidate.startTime < earliest.startTime) {
						return candidate;
					}
					return earliest;
				}, null);

			return {
				element: {
					...element,
					startTime:
						!earliestElement || requestedStartTime <= earliestElement.startTime
							? ZERO_MEDIA_TIME
							: requestedStartTime,
				},
			};
		},
	},
];

export function applyElementUpdate({
	element,
	patch,
	context,
}: {
	element: TimelineElement;
	patch: Partial<TimelineElement>;
	context: ElementUpdateContext;
}): TimelineElement {
	let nextElement = {
		...element,
		...patch,
		params: {
			...element.params,
			...(patch.params ?? {}),
		},
	} as TimelineElement;
	const changedFields = new Set(
		Object.keys(patch) as ElementUpdateField[],
	);

	for (const rule of deriveRules) {
		if (!shouldApplyRule({ rule, changedFields })) {
			continue;
		}

		const result = rule.apply({
			element: nextElement,
			originalElement: element,
			patch,
			context,
		});
		nextElement = result.element;
		for (const field of result.changedFields ?? []) {
			changedFields.add(field);
		}
	}

	for (const rule of enforceRules) {
		if (!shouldApplyRule({ rule, changedFields })) {
			continue;
		}

		nextElement = rule.apply({
			element: nextElement,
			originalElement: element,
			patch,
			context,
		}).element;
	}

	return nextElement;
}

function shouldApplyRule({
	rule,
	changedFields,
}: {
	rule: ElementUpdateRule;
	changedFields: Set<ElementUpdateField>;
}): boolean {
	return rule.triggers.some((trigger) => changedFields.has(trigger));
}

/** How long an element may last before it runs into the next one on its
 * track. */
function getRoomOnTrack({
	element,
	context,
}: {
	element: TimelineElement;
	context: ElementUpdateContext;
}): number {
	const track = findTrackInSceneTracks({
		tracks: context.tracks,
		trackId: context.trackId,
	});
	const end = element.startTime + element.duration;
	const nextStart = (track?.elements ?? []).reduce(
		(earliest, other) =>
			other.id !== element.id && other.startTime >= end
				? Math.min(earliest, other.startTime)
				: earliest,
		Number.POSITIVE_INFINITY,
	);
	return nextStart - element.startTime;
}

function getSourceDuration({
	trimStart,
	trimEnd,
	duration,
	sourceDuration,
	retime,
}: {
	trimStart: number;
	trimEnd: number;
	duration: number;
	sourceDuration?: number;
	retime?: RetimeConfig;
}): number {
	if (typeof sourceDuration === "number") {
		return sourceDuration;
	}

	return (
		trimStart +
		getSourceSpanAtClipTime({
			clipTime: duration,
			retime,
		}) +
		trimEnd
	);
}
