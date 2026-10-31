// The region tracker (rust/crates/tracking) for the editor: a Hide region
// followed through its frames (docs/HIDE.md, phase 2). Frames come as the
// editor renders them, RGBA, small; they're turned grey here.

use tracking::{Frame, Region, Tracker};
use wasm_bindgen::prelude::wasm_bindgen;

/// RGBA pixels as grey, by luminance (BT.709), from 0 to 1.
fn grey(rgba: &[u8]) -> Vec<f32> {
    rgba.as_chunks::<4>()
        .0
        .iter()
        .map(|&[r, g, b, _]| {
            (0.2126 * f32::from(r) + 0.7152 * f32::from(g) + 0.0722 * f32::from(b)) / 255.0
        })
        .collect()
}

/// Follows one region from frame to frame.
#[wasm_bindgen]
pub struct RegionTracker {
    tracker: Tracker,
}

#[wasm_bindgen]
impl RegionTracker {
    /// Starts following the region (its middle and size, in the frame's
    /// pixels) as it is on this frame.
    #[wasm_bindgen(constructor)]
    pub fn new(
        rgba: &[u8],
        width: usize,
        height: usize,
        center_x: f64,
        center_y: f64,
        region_width: f64,
        region_height: f64,
    ) -> RegionTracker {
        let pixels = grey(rgba);
        let frame = Frame {
            width,
            height,
            pixels: &pixels,
        };
        let region = Region {
            center_x,
            center_y,
            width: region_width,
            height: region_height,
        };
        RegionTracker {
            tracker: Tracker::new(&frame, region),
        }
    }

    /// The region on the next frame, as its middle, size and how sure the
    /// match is: `[centerX, centerY, width, height, confidence]`; empty once
    /// it's lost.
    pub fn track(&mut self, rgba: &[u8], width: usize, height: usize) -> Vec<f64> {
        let pixels = grey(rgba);
        let frame = Frame {
            width,
            height,
            pixels: &pixels,
        };
        match self.tracker.track(&frame) {
            Some(found) => vec![
                found.region.center_x,
                found.region.center_y,
                found.region.width,
                found.region.height,
                found.confidence,
            ],
            None => Vec::new(),
        }
    }
}
