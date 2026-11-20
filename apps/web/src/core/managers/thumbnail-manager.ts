import type { EditorCore } from "@/core";
import {
	getThumbnailSize,
	getThumbnailTimes,
	isNearlyBlack,
	THUMBNAIL_QUALITY,
	THUMBNAIL_TYPE,
} from "@/project/thumbnail";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import { buildScene } from "@/services/renderer/scene-builder";

/** After a change, how long the timeline stays still before the open
 * project's thumbnail is taken again. */
export const THUMBNAIL_QUIET_MS = 2000;
/** How soon after one thumbnail the next may be taken: each draws a few frames. */
export const THUMBNAIL_INTERVAL_MS = 30_000;

/** The thumbnail of the open project's timeline: null for an empty one. */
type Capture = () => Promise<string | null>;

/**
 * The open project's thumbnail, for the projects page: taken again a moment
 * after its timeline changes, so that it's up to date however the project is
 * left (Quit, the window closed, another opened), and not while it plays or
 * exports, which draw frames of their own.
 */
export class ThumbnailManager {
	private readonly editor: EditorCore;
	private readonly quietMs: number;
	private readonly intervalMs: number;
	private readonly now: () => number;
	private readonly capture: Capture;
	private timer: ReturnType<typeof setTimeout> | null = null;
	/** The project the timer is for. */
	private timerProjectId: string | null = null;
	/** The last thumbnail taken, of which project and when. */
	private lastTaken: { projectId: string; at: number } | null = null;
	private taking: Promise<boolean> | null = null;
	private unsubscribeHandlers: Array<() => void> = [];

	constructor({
		editor,
		quietMs = THUMBNAIL_QUIET_MS,
		intervalMs = THUMBNAIL_INTERVAL_MS,
		now = () => performance.now(),
		capture,
	}: {
		editor: EditorCore;
		quietMs?: number;
		intervalMs?: number;
		now?: () => number;
		capture?: Capture;
	}) {
		this.editor = editor;
		this.quietMs = quietMs;
		this.intervalMs = intervalMs;
		this.now = now;
		this.capture = capture ?? (() => this.captureTimeline());
	}

	start(): void {
		if (this.unsubscribeHandlers.length > 0) return;
		this.unsubscribeHandlers = [
			this.editor.scenes.subscribe(() => this.handleChange()),
			this.editor.timeline.subscribe(() => this.handleChange()),
		];
	}

	stop(): void {
		for (const unsubscribe of this.unsubscribeHandlers) {
			unsubscribe();
		}
		this.unsubscribeHandlers = [];
		this.clearTimer();
	}

	/**
	 * Takes the open project's thumbnail now, once any being taken is: none
	 * for an empty timeline. Whether it changed. Throws if it can't be drawn.
	 */
	async refresh(): Promise<boolean> {
		this.clearTimer();
		while (this.taking) {
			await this.taking.catch(() => undefined);
		}
		const project = this.editor.project.getActiveOrNull();
		if (!project) return false;
		this.taking = this.take({ projectId: project.metadata.id });
		try {
			return await this.taking;
		} finally {
			this.taking = null;
		}
	}

	private async take({ projectId }: { projectId: string }): Promise<boolean> {
		const startedAt = this.now();
		const thumbnail = await this.capture();
		// An empty timeline draws nothing: the next may come at once.
		if (thumbnail !== null) this.lastTaken = { projectId, at: startedAt };
		// Closed, or another opened, meanwhile: not this one's.
		const active = this.editor.project.getActiveOrNull();
		if (active?.metadata.id !== projectId) return false;
		if (thumbnail === null && !active.metadata.thumbnail) return false;
		await this.editor.project.updateThumbnail({
			thumbnail: thumbnail ?? undefined,
		});
		return true;
	}

	private handleChange(): void {
		const project = this.editor.project;
		const projectId = project.getLoadedProjectId();
		// While a project loads, its scenes arrive: no change to it.
		if (!projectId || project.getActiveOrNull()?.metadata.id !== projectId) {
			return;
		}
		const nextAllowed =
			this.lastTaken?.projectId === projectId
				? this.lastTaken.at + this.intervalMs
				: Number.NEGATIVE_INFINITY;
		this.schedule({
			projectId,
			delay: Math.max(this.quietMs, nextAllowed - this.now()),
		});
	}

	private schedule({
		projectId,
		delay,
	}: {
		projectId: string;
		delay: number;
	}): void {
		this.clearTimer();
		this.timerProjectId = projectId;
		this.timer = setTimeout(() => this.handleTimer(), delay);
	}

	private handleTimer(): void {
		const projectId = this.timerProjectId;
		this.timer = null;
		this.timerProjectId = null;
		const project = this.editor.project;
		if (
			!projectId ||
			project.getLoadedProjectId() !== projectId ||
			project.getActiveOrNull()?.metadata.id !== projectId
		) {
			return;
		}
		if (
			this.taking ||
			this.editor.playback.getIsPlaying() ||
			project.getExportState().isExporting
		) {
			this.schedule({ projectId, delay: this.quietMs });
			return;
		}
		this.refresh().catch((error: unknown) => {
			console.error("Failed to update the project thumbnail:", error);
		});
	}

	private clearTimer(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.timerProjectId = null;
	}

	private async captureTimeline(): Promise<string | null> {
		const project = this.editor.project.getActiveOrNull();
		const duration = this.editor.timeline.getTotalDuration();
		if (!project || duration <= 0) return null;

		const { canvasSize, background, fps } = project.settings;
		const scene = buildScene({
			tracks: this.editor.scenes.getActiveScene().tracks,
			mediaAssets: this.editor.media.getAssets(),
			duration,
			canvasSize,
			background,
		});
		const renderer = new CanvasRenderer({ ...canvasSize, fps });
		const size = getThumbnailSize(canvasSize);
		const target = createCanvas(size);
		const context = target.getContext("2d", { willReadFrequently: true });
		if (!context) throw new Error("Failed to get a 2D canvas");
		context.imageSmoothingQuality = "high";

		// The first frame, if they're all black.
		let first: HTMLCanvasElement | null = null;
		for (const time of getThumbnailTimes({
			lastFrameTime: this.editor.timeline.getLastFrameTime(),
		})) {
			await renderer.renderToCanvas({
				node: scene,
				time,
				targetCanvas: target,
			});
			const { data } = context.getImageData(0, 0, size.width, size.height);
			if (!isNearlyBlack({ pixels: data })) {
				return target.toDataURL(THUMBNAIL_TYPE, THUMBNAIL_QUALITY);
			}
			if (!first) {
				first = createCanvas(size);
				first.getContext("2d")?.drawImage(target, 0, 0);
			}
		}
		return (first ?? target).toDataURL(THUMBNAIL_TYPE, THUMBNAIL_QUALITY);
	}
}

function createCanvas({
	width,
	height,
}: {
	width: number;
	height: number;
}): HTMLCanvasElement {
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	return canvas;
}
