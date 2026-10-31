import type {
	ImageElement,
	SceneTracks,
	TimelineElement,
	TimelineTrack,
	VideoElement,
} from "@/timeline";
import {
	getTransitionDefinition,
	resolveTrackTransitions,
	type ResolvedTransition,
} from "@/transitions";
import type { MediaAsset } from "@/media/types";
import { RootNode } from "./nodes/root-node";
import { VideoNode } from "./nodes/video-node";
import { ImageNode } from "./nodes/image-node";
import { TextNode } from "./nodes/text-node";
import { StickerNode } from "./nodes/sticker-node";
import { GraphicNode } from "./nodes/graphic-node";
import { ColorNode } from "./nodes/color-node";
import { BlurBackgroundNode } from "./nodes/blur-background-node";
import { EffectLayerNode } from "./nodes/effect-layer-node";
import { TransitionNode } from "./nodes/transition-node";
import type { AnyBaseNode } from "./nodes/base-node";
import type { TBackground, TCanvasSize } from "@/project/types";
import { DEFAULT_BACKGROUND_BLUR_INTENSITY } from "@/background/blur";
import {
	buildTransformFromParams,
	readBlendModeFromParams,
	readOpacityFromParams,
} from "@/rendering";

const PREVIEW_MAX_IMAGE_SIZE = 2048;

function getVisibleSortedElements({ track }: { track: TimelineTrack }) {
	return track.elements
		.filter((element) => !("hidden" in element && element.hidden))
		.slice()
		.sort((a, b) => {
			if (a.startTime !== b.startTime) return a.startTime - b.startTime;
			return a.id.localeCompare(b.id);
		});
}

type ActiveRange = { start: number; end: number };

function buildElementNode({
	element,
	mediaMap,
	canvasSize,
	isPreview,
	activeRange,
	streamKey,
}: {
	element: TimelineElement;
	mediaMap: Map<string, MediaAsset>;
	canvasSize: TCanvasSize;
	isPreview?: boolean;
	activeRange?: ActiveRange;
	streamKey?: string;
}): AnyBaseNode | null {
	if (element.type === "effect") {
		return new EffectLayerNode({
			effectType: element.effectType,
			effectParams: element.params,
			timeOffset: element.startTime,
			duration: element.duration,
			masks: element.masks,
		});
	}

	if (element.type === "video" || element.type === "image") {
		const mediaAsset = mediaMap.get(element.mediaId);
		if (!mediaAsset?.file) {
			return null;
		}

		if (element.type === "video" && mediaAsset.type === "video") {
			return new VideoNode({
				mediaId: mediaAsset.id,
				file: mediaAsset.file,
				duration: element.duration,
				timeOffset: element.startTime,
				trimStart: element.trimStart,
				trimEnd: element.trimEnd,
				retime: element.retime,
				transform: buildTransformFromParams({ params: element.params }),
				animations: element.animations,
				opacity: readOpacityFromParams({ params: element.params }),
				blendMode: readBlendModeFromParams({ params: element.params }),
				effects: element.effects ?? [],
				masks: element.masks ?? [],
				activeRange,
				streamKey,
			});
		}
		if (
			element.type === "image" &&
			mediaAsset.type === "image" &&
			mediaAsset.url
		) {
			return new ImageNode({
				url: mediaAsset.url,
				duration: element.duration,
				timeOffset: element.startTime,
				trimStart: element.trimStart,
				trimEnd: element.trimEnd,
				transform: buildTransformFromParams({ params: element.params }),
				animations: element.animations,
				opacity: readOpacityFromParams({ params: element.params }),
				blendMode: readBlendModeFromParams({ params: element.params }),
				effects: element.effects ?? [],
				masks: element.masks ?? [],
				activeRange,
				...(isPreview && {
					maxSourceSize: PREVIEW_MAX_IMAGE_SIZE,
				}),
			});
		}
		return null;
	}

	if (element.type === "text") {
		return new TextNode({
			...element,
			transform: buildTransformFromParams({ params: element.params }),
			opacity: readOpacityFromParams({ params: element.params }),
			blendMode: readBlendModeFromParams({ params: element.params }),
			canvasCenter: { x: canvasSize.width / 2, y: canvasSize.height / 2 },
			canvasHeight: canvasSize.height,
			textBaseline: "middle",
			effects: element.effects ?? [],
		});
	}

	if (element.type === "sticker") {
		return new StickerNode({
			stickerId: element.stickerId,
			intrinsicWidth: element.intrinsicWidth,
			intrinsicHeight: element.intrinsicHeight,
			duration: element.duration,
			timeOffset: element.startTime,
			trimStart: element.trimStart,
			trimEnd: element.trimEnd,
			transform: buildTransformFromParams({ params: element.params }),
			animations: element.animations,
			opacity: readOpacityFromParams({ params: element.params }),
			blendMode: readBlendModeFromParams({ params: element.params }),
			effects: element.effects ?? [],
		});
	}

	if (element.type === "graphic") {
		return new GraphicNode({
			definitionId: element.definitionId,
			params: element.params,
			duration: element.duration,
			timeOffset: element.startTime,
			trimStart: element.trimStart,
			trimEnd: element.trimEnd,
			transform: buildTransformFromParams({ params: element.params }),
			animations: element.animations,
			opacity: readOpacityFromParams({ params: element.params }),
			blendMode: readBlendModeFromParams({ params: element.params }),
			effects: element.effects ?? [],
			masks: element.masks ?? [],
		});
	}

	return null;
}

/**
 * When each clip in a transition shows by itself: its clip less the
 * transitions' windows at its ends.
 */
function getStandaloneRanges({
	transitions,
}: {
	transitions: ResolvedTransition[];
}): Map<string, ActiveRange> {
	const ranges = new Map<string, ActiveRange>();
	const rangeOf = (element: VideoElement | ImageElement) => {
		let range = ranges.get(element.id);
		if (!range) {
			range = {
				start: element.startTime,
				end: element.startTime + element.duration,
			};
			ranges.set(element.id, range);
		}
		return range;
	};
	for (const { from, to, window } of transitions) {
		rangeOf(from).end = Math.min(rangeOf(from).end, window.start);
		rangeOf(to).start = Math.max(rangeOf(to).start, window.end);
	}
	return ranges;
}

/**
 * Decoders for the clips in transitions: two in turn, so that the clips on
 * either side of a cut, even of one file, decode side by side, and each goes
 * on from its own frames into the transition.
 */
function getStreamKeys({
	elements,
	transitions,
}: {
	elements: TimelineElement[];
	transitions: ResolvedTransition[];
}): Map<string, string> {
	const inTransitions = new Set(
		transitions.flatMap(({ from, to }) => [from.id, to.id]),
	);
	const keys = new Map<string, string>();
	elements.forEach((element, index) => {
		if (inTransitions.has(element.id)) {
			keys.set(element.id, `transition-${index % 2}`);
		}
	});
	return keys;
}

function buildTrackNodes({
	tracks,
	mediaMap,
	canvasSize,
	isPreview,
}: {
	tracks: TimelineTrack[];
	mediaMap: Map<string, MediaAsset>;
	canvasSize: TCanvasSize;
	isPreview?: boolean;
}): AnyBaseNode[] {
	const nodes: AnyBaseNode[] = [];

	for (const track of tracks) {
		const elements = getVisibleSortedElements({ track });
		const transitions =
			track.type === "video" ? resolveTrackTransitions({ track }) : [];
		const ranges = getStandaloneRanges({ transitions });
		const streamKeys = getStreamKeys({ elements, transitions });

		for (const element of elements) {
			const node = buildElementNode({
				element,
				mediaMap,
				canvasSize,
				isPreview,
				activeRange: ranges.get(element.id),
				streamKey: streamKeys.get(element.id),
			});
			if (node) {
				nodes.push(node);
			}
		}

		for (const { transition, from, to, window } of transitions) {
			const side = (element: VideoElement | ImageElement) =>
				buildElementNode({
					element,
					mediaMap,
					canvasSize,
					isPreview,
					activeRange: window,
					streamKey: streamKeys.get(element.id),
				});
			const definition = getTransitionDefinition({ type: transition.type });
			nodes.push(
				new TransitionNode({
					from: side(from),
					to: side(to),
					shader: definition.shader,
					params: { ...definition.params, ...transition.params },
					window,
				}),
			);
		}
	}

	return nodes;
}

function buildBlurBackgroundNodes({
	track,
	mediaMap,
	blurIntensity,
}: {
	track: TimelineTrack | undefined;
	mediaMap: Map<string, MediaAsset>;
	blurIntensity: number;
}): AnyBaseNode[] {
	if (!track) {
		return [];
	}

	const nodes: AnyBaseNode[] = [];
	const elements = getVisibleSortedElements({ track });

	for (const element of elements) {
		if (element.type !== "video" && element.type !== "image") {
			continue;
		}

		const mediaAsset = mediaMap.get(element.mediaId);
		if (
			!mediaAsset?.file ||
			(mediaAsset.type === "image" && !mediaAsset.url) ||
			(mediaAsset.type !== "video" && mediaAsset.type !== "image")
		) {
			continue;
		}

		nodes.push(
			new BlurBackgroundNode({
				mediaId: mediaAsset.id,
				url: mediaAsset.url,
				file: mediaAsset.file,
				mediaType: mediaAsset.type,
				duration: element.duration,
				timeOffset: element.startTime,
				trimStart: element.trimStart,
				trimEnd: element.trimEnd,
				retime: element.type === "video" ? element.retime : undefined,
				blurIntensity,
			}),
		);
	}

	return nodes;
}

export type BuildSceneParams = {
	canvasSize: TCanvasSize;
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
	duration: number;
	background: TBackground;
	isPreview?: boolean;
};

export function buildScene({
	canvasSize,
	tracks,
	mediaAssets,
	duration,
	background,
	isPreview,
}: BuildSceneParams) {
	const rootNode = new RootNode({ duration });
	const mediaMap = new Map(mediaAssets.map((m) => [m.id, m]));

	const visibleTracks = [
		...tracks.overlay.filter((track) => !("hidden" in track && track.hidden)),
		...(!tracks.main.hidden ? [tracks.main] : []),
	];
	const orderedTracksBottomToTop = visibleTracks.slice().reverse();
	const mainTrack = tracks.main.hidden ? undefined : tracks.main;

	const allNodes = buildTrackNodes({
		tracks: orderedTracksBottomToTop,
		mediaMap,
		canvasSize,
		isPreview,
	});

	if (background.type === "blur") {
		const blurNodes = buildBlurBackgroundNodes({
			track: mainTrack,
			mediaMap,
			blurIntensity:
				background.blurIntensity ?? DEFAULT_BACKGROUND_BLUR_INTENSITY,
		});
		for (const node of blurNodes) {
			rootNode.add(node);
		}
	} else if (
		background.type === "color" &&
		background.color !== "transparent"
	) {
		rootNode.add(new ColorNode({ color: background.color }));
	}

	for (const node of allNodes) {
		rootNode.add(node);
	}

	return rootNode;
}
