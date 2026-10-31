import * as ort from "onnxruntime-web";
import {
	crop,
	decodeYolo,
	decodeYuNet,
	fromLetterbox,
	letterbox,
	merge,
	tiles,
	type Detection,
} from "./detect";
import type { TrackFrame } from "./track";

// The detection models (docs/HIDE.md, phase 3): downloaded once from Hugging
// Face, at a fixed revision, checked against their SHA-256 and kept in the
// browser's cache; run on the computer by ONNX Runtime, the copy the app
// ships. Nothing is sent.

const DETECTORS = {
	faces: {
		// YuNet, OpenCV's (MIT).
		url: "https://huggingface.co/opencv/face_detection_yunet/resolve/3cc26e7f1014a5ee5d74a42acee58bafc9d0a310/face_detection_yunet_2023mar.onnx",
		sha256: "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
		input: "input",
		order: "bgr255",
		threshold: 0.6,
		// Finds overlapping more are the same face.
		overlap: 0.3,
	},
	plates: {
		// A YOLOv11 tuned for plates (AGPL-3.0).
		url: "https://huggingface.co/morsetechlab/yolov11-license-plate-detection/resolve/251a30d7daedca065f56e04b0af04052c907c68f/license-plate-finetune-v1n.onnx",
		sha256: "693133a1db97a3ba1e90068986f80afb72c3fcddb681e57181a89a9a3dc351d6",
		input: "images",
		order: "rgb1",
		threshold: 0.35,
		overlap: 0.45,
	},
} as const;

export type DetectorKind = keyof typeof DETECTORS;

// The square the models see a frame in.
const MODEL_SIZE = 640;

const CACHE_NAME = "magnetcut-models";

function hex({ bytes }: { bytes: ArrayBuffer }): string {
	return [...new Uint8Array(bytes)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

/** A model's file, from the cache or downloaded once, as published. */
async function download({ kind }: { kind: DetectorKind }): Promise<Uint8Array> {
	const { url, sha256 } = DETECTORS[kind];
	const cache = await caches.open(CACHE_NAME);
	const cached = await cache.match(url);
	const response = cached ?? (await fetch(url));
	if (!response.ok) {
		throw new Error(`Couldn't download the ${kind} model (${response.status})`);
	}
	const bytes = await response.clone().arrayBuffer();
	const digest = hex({ bytes: await crypto.subtle.digest("SHA-256", bytes) });
	if (digest !== sha256) {
		if (cached) await cache.delete(url);
		throw new Error(`The ${kind} model isn't the one published: not used`);
	}
	if (!cached) await cache.put(url, response);
	return new Uint8Array(bytes);
}

let isRuntimeSet = false;

function setRuntime() {
	if (isRuntimeSet) return;
	// In its own worker, so the editor stays responsive.
	ort.env.wasm.proxy = true;
	isRuntimeSet = true;
}

const sessions = new Map<DetectorKind, Promise<ort.InferenceSession>>();

function session({
	kind,
}: {
	kind: DetectorKind;
}): Promise<ort.InferenceSession> {
	const existing = sessions.get(kind);
	if (existing) return existing;
	setRuntime();
	const created = download({ kind }).then((model) =>
		ort.InferenceSession.create(model, {
			executionProviders: ["webgpu", "wasm"],
		}),
	);
	// A failed load is tried again next time.
	created.catch(() => sessions.delete(kind));
	sessions.set(kind, created);
	return created;
}

/** The faces or plates on a frame, in its pixels: looked for in the whole
 * frame and, where it's much bigger than the model's square, in squares of
 * it too, where small ones keep their pixels. */
export async function detect({
	kind,
	frame,
}: {
	kind: DetectorKind;
	frame: TrackFrame;
}): Promise<Detection[]> {
	const found = await look({ kind, frame });
	const parts = tiles({
		width: frame.width,
		height: frame.height,
		size: MODEL_SIZE,
	});
	if (parts.length === 0) return found;
	for (const { x, y, side } of parts) {
		const inPart = await look({
			kind,
			frame: {
				rgba: crop({ rgba: frame.rgba, width: frame.width, x, y, side }),
				width: side,
				height: side,
			},
		});
		for (const detection of inPart) {
			found.push({ ...detection, x: detection.x + x, y: detection.y + y });
		}
	}
	return merge({ detections: found, threshold: DETECTORS[kind].overlap });
}

/** The faces or plates the model finds in a frame, in its pixels. */
async function look({
	kind,
	frame,
}: {
	kind: DetectorKind;
	frame: TrackFrame;
}): Promise<Detection[]> {
	const detector = DETECTORS[kind];
	const model = await session({ kind });
	const box = letterbox({
		rgba: frame.rgba,
		width: frame.width,
		height: frame.height,
		size: MODEL_SIZE,
		order: detector.order,
	});
	const results = await model.run({
		[detector.input]: new ort.Tensor("float32", box.data, [
			1,
			3,
			MODEL_SIZE,
			MODEL_SIZE,
		]),
	});
	const outputs: Record<string, Float32Array> = {};
	for (const [name, tensor] of Object.entries(results)) {
		if (tensor.data instanceof Float32Array) outputs[name] = tensor.data;
	}
	const found =
		kind === "faces"
			? decodeYuNet({
					outputs,
					size: MODEL_SIZE,
					threshold: detector.threshold,
				})
			: decodeYolo({
					output: outputs.output0 ?? new Float32Array(),
					count: results.output0?.dims[2] ?? 0,
					threshold: detector.threshold,
				});
	return found.map((detection) => fromLetterbox({ detection, box }));
}
