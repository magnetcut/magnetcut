// The compositor draws into one canvas, the one the preview shows. Frames
// drawn for someone else (Track, Find, a snapshot, black bars, the agent's
// look) would show there: a Hide region's face among them. Before the first
// of them, a copy of what the preview shows is laid over it and the canvas
// is hidden, until the preview draws its own frame again.

// How long after the last frame drawn for someone else the preview draws its
// own again: frames drawn one after another (Track's) go on undisturbed.
export const HOLD_SETTLE_MS = 250;

export class OutputHold {
	private readonly createCanvas: () => HTMLCanvasElement;
	private readonly now: () => number;
	private cover: HTMLCanvasElement | null = null;
	/** When the last frame for someone else was drawn: null when not held. */
	private heldAt: number | null = null;

	constructor({
		createCanvas,
		now = () => performance.now(),
	}: {
		createCanvas: () => HTMLCanvasElement;
		now?: () => number;
	}) {
		this.createCanvas = createCanvas;
		this.now = now;
	}

	/** The copy laid over the canvas while it's held: hidden until then. */
	getCover(): HTMLCanvasElement {
		if (!this.cover) {
			const cover = this.createCanvas();
			Object.assign(cover.style, {
				position: "absolute",
				inset: "0",
				width: "100%",
				height: "100%",
				pointerEvents: "none",
				display: "none",
			});
			this.cover = cover;
		}
		return this.cover;
	}

	isHeld(): boolean {
		return this.heldAt !== null;
	}

	/** Whether frames were drawn for someone else and have stopped a moment. */
	isSettled(): boolean {
		return this.heldAt !== null && this.now() - this.heldAt >= HOLD_SETTLE_MS;
	}

	/**
	 * Before a frame for someone else is drawn into `output`: the first time,
	 * what it shows (the preview's frame) is copied over it, and it's hidden.
	 */
	hold({ output }: { output: HTMLCanvasElement | null }): void {
		if (this.heldAt === null && output) {
			const cover = this.getCover();
			cover.width = output.width;
			cover.height = output.height;
			try {
				cover.getContext("2d")?.drawImage(output, 0, 0);
			} catch {
				// Nothing to copy: the preview shows its background meanwhile.
			}
			cover.style.display = "block";
		}
		if (output) output.style.visibility = "hidden";
		this.heldAt = this.now();
	}

	/** Once the preview has drawn its own frame into `output`: shown again. */
	release({ output }: { output: HTMLCanvasElement | null }): void {
		if (this.heldAt === null) return;
		this.heldAt = null;
		if (output) output.style.visibility = "";
		if (this.cover) {
			this.cover.style.display = "none";
			// Its pixels freed until the next hold.
			this.cover.width = 0;
			this.cover.height = 0;
		}
	}
}
