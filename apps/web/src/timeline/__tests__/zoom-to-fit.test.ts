import { describe, expect, test } from "bun:test";
import {
	ZoomController,
	type ZoomConfig,
} from "../controllers/zoom-controller";
import { TIMELINE_ZOOM_MAX } from "../scale";
import { getTimelineZoomMin, getTimelineZoomToFit } from "../zoom-utils";
import { mediaTime, TICKS_PER_SECOND } from "@/wasm";

const seconds = (value: number) => Math.round(value * TICKS_PER_SECOND);

describe("the zoom that fits the timeline", () => {
	test("its end just inside the view", () => {
		// 20 s at 50 px a second is 1000 px at zoom 1: 95% of 1000 px.
		expect(
			getTimelineZoomToFit({ duration: seconds(20), viewportWidth: 1000 }),
		).toBeCloseTo(0.95);
	});

	test("closer than the furthest out, which leaves room past the end", () => {
		const fit = getTimelineZoomToFit({
			duration: seconds(20),
			viewportWidth: 1000,
		});
		const min = getTimelineZoomMin({
			duration: seconds(20),
			containerWidth: 1000,
		});
		expect(fit).toBeGreaterThan(min);
	});

	test("no closer than the closest", () => {
		expect(getTimelineZoomToFit({ duration: 1, viewportWidth: 1000 })).toBe(
			TIMELINE_ZOOM_MAX,
		);
	});

	test("none for an empty timeline or no view", () => {
		expect(getTimelineZoomToFit({ duration: 0, viewportWidth: 1000 })).toBe(
			null,
		);
		expect(
			getTimelineZoomToFit({ duration: seconds(20), viewportWidth: 0 }),
		).toBe(null);
	});
});

/** What the controller reads of a scroll element, there being no DOM here. */
function asScrollElement({
	element,
}: {
	element: { scrollLeft: number; scrollWidth?: number; clientWidth?: number };
}): HTMLDivElement {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- a stand-in with only the properties zooming reads.
	return element as unknown as HTMLDivElement;
}

function setUp({ playheadSeconds }: { playheadSeconds: number }) {
	const tracks = { scrollLeft: 4000, scrollWidth: 20000, clientWidth: 1000 };
	const ruler = { scrollLeft: 4000 };
	const config: ZoomConfig = {
		minZoom: 0.1,
		getContainerEl: () => null,
		getTracksScrollEl: () => asScrollElement({ element: tracks }),
		getRulerScrollEl: () => asScrollElement({ element: ruler }),
		getCurrentPlayheadTime: () =>
			mediaTime({ ticks: seconds(playheadSeconds) }),
		seek: () => {},
		setTimelineViewState: () => {},
	};
	const controller = new ZoomController({
		configRef: { current: config },
		initialZoom: 20,
	});
	return { controller, tracks, ruler };
}

describe("zooming to a place", () => {
	test("scrolled there, not kept on the playhead", () => {
		// Zoomed in this far, a zoom keeps the playhead where it is on screen.
		const { controller, tracks, ruler } = setUp({ playheadSeconds: 90 });
		controller.zoomTo({ zoomLevel: 10, scrollLeft: 0 });
		// What the timeline's layout effect does once the new width is drawn.
		controller.applyZoomLayout(controller.zoomLevel);
		expect(controller.zoomLevel).toBe(10);
		expect(tracks.scrollLeft).toBe(0);
		expect(ruler.scrollLeft).toBe(0);
		controller.destroy();
	});

	test("scrolled there when the zoom is already that", () => {
		const { controller, tracks, ruler } = setUp({ playheadSeconds: 90 });
		controller.zoomTo({ zoomLevel: 20, scrollLeft: 0 });
		expect(tracks.scrollLeft).toBe(0);
		expect(ruler.scrollLeft).toBe(0);
		controller.destroy();
	});

	test("a zoom after it keeps the playhead again", () => {
		const { controller, tracks } = setUp({ playheadSeconds: 9 });
		controller.zoomTo({ zoomLevel: 10, scrollLeft: 0 });
		controller.applyZoomLayout(controller.zoomLevel);
		controller.setZoomLevel(15);
		controller.applyZoomLayout(controller.zoomLevel);
		// The playhead, 9 s in, stays where it was on screen: 4500 px in at
		// zoom 10 (50 px a second), 6750 px at 15; the view moves with it.
		expect(tracks.scrollLeft).toBe(2250);
		controller.destroy();
	});
});
