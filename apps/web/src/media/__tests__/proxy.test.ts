import { describe, expect, test } from "bun:test";
import type { MediaAsset } from "@/media/types";
import { getProxyMediaId } from "@/media/proxy-id";
import type { AnyBaseNode } from "@/services/renderer/nodes/base-node";
import { VideoNode } from "@/services/renderer/nodes/video-node";
import { buildScene } from "@/services/renderer/scene-builder";
import type { SceneTracks } from "@/timeline";
import { mediaTime, TICKS_PER_SECOND } from "@/wasm";
import {
	canHaveProxy,
	chooseProxySize,
	nameProxyFile,
	PROXY_LONG_SIDE,
} from "../proxy";

const seconds = (value: number) =>
	mediaTime({ ticks: Math.round(value * TICKS_PER_SECOND) });

const original = new File([], "talk.mov");
const small = new File([], "talk (proxy 960×540).mp4");

function asset({
	width = 3840,
	height = 2160,
	proxy = true,
}: {
	width?: number;
	height?: number;
	proxy?: boolean;
} = {}): MediaAsset {
	return {
		id: "talk",
		name: "talk.mov",
		type: "video",
		file: original,
		width,
		height,
		duration: 5,
		proxy: proxy ? { file: small, width: 960, height: 540 } : undefined,
	};
}

function videoNodesOf({ root }: { root: AnyBaseNode }): VideoNode[] {
	const found: VideoNode[] = [];
	const visit = (node: AnyBaseNode) => {
		if (node instanceof VideoNode) found.push(node);
		for (const child of node.children) visit(child);
	};
	visit(root);
	return found;
}

function sceneWith({
	isPreview,
	useProxies,
}: {
	isPreview: boolean;
	useProxies: boolean;
}) {
	const tracks: SceneTracks = {
		overlay: [],
		main: {
			id: "main",
			name: "Main",
			type: "video",
			elements: [
				{
					id: "clip",
					type: "video",
					name: "talk",
					mediaId: "talk",
					startTime: seconds(0),
					duration: seconds(5),
					trimStart: seconds(0),
					trimEnd: seconds(0),
					params: {},
				},
			],
			muted: false,
			hidden: false,
		},
		audio: [],
	};
	return buildScene({
		canvasSize: { width: 1920, height: 1080 },
		tracks,
		mediaAssets: [asset()],
		duration: seconds(5),
		background: { type: "color", color: "transparent" },
		isPreview,
		useProxies,
	});
}

describe("proxies", () => {
	test("a proxy keeps the video's shape, its long side 960", () => {
		expect(chooseProxySize({ width: 3840, height: 2160 })).toEqual({
			width: PROXY_LONG_SIDE,
			height: 540,
		});
		expect(chooseProxySize({ width: 2160, height: 3840 })).toEqual({
			width: 540,
			height: PROXY_LONG_SIDE,
		});
		expect(chooseProxySize({ width: 1440, height: 1080 })).toEqual({
			width: 960,
			height: 720,
		});
	});

	test("a video small enough already has none", () => {
		expect(chooseProxySize({ width: 1280, height: 720 })).toBeNull();
		expect(chooseProxySize({ width: 0, height: 0 })).toBeNull();
		expect(
			canHaveProxy({
				asset: asset({ width: 1280, height: 720, proxy: false }),
			}),
		).toBe(false);
		expect(canHaveProxy({ asset: asset({ proxy: false }) })).toBe(true);
		expect(canHaveProxy({ asset: asset() })).toBe(false);
	});

	test("a proxy's file is named after the video", () => {
		expect(
			nameProxyFile({
				name: "talk.mov",
				size: { width: 960, height: 540 },
				extension: "mp4",
			}),
		).toBe("talk (proxy 960×540).mp4");
	});

	test("the preview plays the proxy when they're on", () => {
		const [node] = videoNodesOf({
			root: sceneWith({ isPreview: true, useProxies: true }),
		});
		expect(node?.params.file).toBe(small);
		expect(node?.params.mediaId).toBe(getProxyMediaId({ id: "talk" }));
	});

	test("the preview plays the original when they're off, and an export always does", () => {
		for (const options of [
			{ isPreview: true, useProxies: false },
			{ isPreview: false, useProxies: true },
		]) {
			const [node] = videoNodesOf({ root: sceneWith(options) });
			expect(node?.params.file).toBe(original);
			expect(node?.params.mediaId).toBe("talk");
		}
	});
});
