import { describe, expect, test } from "bun:test";
import type { MediaAsset } from "@/media/types";
import type { ImageElement, SceneTracks, VideoElement } from "@/timeline";
import { mediaTime, TICKS_PER_SECOND } from "@/wasm";
import { ImageNode } from "../nodes/image-node";
import { TransitionNode } from "../nodes/transition-node";
import { VideoNode } from "../nodes/video-node";
import { buildScene } from "../scene-builder";

const seconds = (value: number) =>
	mediaTime({ ticks: Math.round(value * TICKS_PER_SECOND) });

const asset = ({ id, type }: { id: string; type: "image" | "video" }) =>
	({
		id,
		name: id,
		type,
		file: new File([], id),
		url: `blob:${id}`,
	}) satisfies MediaAsset;

function clip({
	id,
	type,
	start,
}: {
	id: string;
	type: "image" | "video";
	start: number;
}): ImageElement | VideoElement {
	return {
		id,
		type,
		name: id,
		mediaId: type,
		startTime: seconds(start),
		duration: seconds(5),
		trimStart: seconds(2),
		trimEnd: seconds(2),
		params: {},
	};
}

function scene({ type }: { type: "image" | "video" }) {
	const tracks: SceneTracks = {
		overlay: [],
		main: {
			id: "main",
			name: "Main",
			type: "video",
			elements: [
				clip({ id: "a", type, start: 0 }),
				clip({ id: "b", type, start: 5 }),
				clip({ id: "c", type, start: 10 }),
			],
			muted: false,
			hidden: false,
			transitions: [
				{
					id: "ab",
					fromElementId: "a",
					toElementId: "b",
					type: "dip-to-white",
					duration: seconds(1),
					alignment: "center",
					params: { colorPhase: 0.3 },
					crossfadeAudio: true,
				},
			],
		},
		audio: [],
	};
	return buildScene({
		canvasSize: { width: 1920, height: 1080 },
		tracks,
		mediaAssets: [asset({ id: type, type })],
		duration: seconds(15),
		background: { type: "color", color: "transparent" },
	});
}

const range = ({ start, end }: { start: number; end: number }) => ({
	start: seconds(start),
	end: seconds(end),
});

describe("transitions in the scene", () => {
	test("each clip by itself up to the window, both in it", () => {
		const root = scene({ type: "image" });
		const clips = root.children.filter((node) => node instanceof ImageNode);
		expect(clips.map((node) => node.params.activeRange)).toEqual([
			range({ start: 0, end: 4.5 }),
			range({ start: 5.5, end: 10 }),
			undefined,
		]);

		const [transition] = root.children.filter(
			(node) => node instanceof TransitionNode,
		);
		expect(transition).toBeInstanceOf(TransitionNode);
		if (!(transition instanceof TransitionNode)) return;
		expect(transition.params.shader).toBe("FadeColor");
		// The catalogue's parameters, with the transition's own over them.
		expect(transition.params.params).toEqual({
			color: [1, 1, 1, 1],
			colorPhase: 0.3,
		});
		for (const side of [transition.from, transition.to]) {
			expect(side).toBeInstanceOf(ImageNode);
			if (side instanceof ImageNode) {
				expect(side.params.activeRange).toMatchObject(
					range({ start: 4.5, end: 5.5 }),
				);
			}
		}
	});

	test("the two clips of a cut decode from their own streams", () => {
		const root = scene({ type: "video" });
		const keys = root.children
			.filter((node) => node instanceof VideoNode)
			.map((node) => node.params.streamKey);
		// c isn't in a transition: the file's usual decoder.
		expect(keys).toEqual(["transition-0", "transition-1", undefined]);
		const [transition] = root.children.filter(
			(node) => node instanceof TransitionNode,
		);
		if (!(transition instanceof TransitionNode)) throw new Error("none");
		const sideKeys = [transition.from, transition.to].map((side) =>
			side instanceof VideoNode ? side.params.streamKey : null,
		);
		expect(sideKeys).toEqual(["transition-0", "transition-1"]);
	});
});
