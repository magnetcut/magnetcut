//! A region followed through a film, frame by frame: what's inside it on the
//! first frame found again on each next one (docs/HIDE.md, phase 2). Each
//! frame is grey (luminance) at a small size; the region is matched around
//! where it was, at three sizes, by normalised cross-correlation, refined to
//! a fraction of a pixel. While the match is sure, the template takes in a
//! little of what it finds, so that a face turning stays found; once it
//! isn't, the region is lost, and the tracker says so rather than guess.

/// A grey picture, row by row, from 0 to 1.
pub struct Frame<'a> {
    pub width: usize,
    pub height: usize,
    pub pixels: &'a [f32],
}

/// A region of a frame: its middle and its size, in the frame's pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Region {
    pub center_x: f64,
    pub center_y: f64,
    pub width: f64,
    pub height: f64,
}

/// Where the region is on a frame, and how sure the match is (from -1 to 1).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Found {
    pub region: Region,
    pub confidence: f64,
}

// The template's longer side, in its own pixels.
const TEMPLATE_SIZE: usize = 32;

// How far the region is looked for, as a share of the template's longer side
// on each side of where it was.
const SEARCH: f64 = 0.5;

// The sizes tried, as shares of the last.
const SCALES: [f64; 3] = [0.97, 1.0, 1.03];

// Below this, the match isn't the region: lost.
const LOST: f64 = 0.45;

// Above this, the template takes in this much of what it found.
const SURE: f64 = 0.8;
const LEARNING: f32 = 0.1;

/// Follows one region from frame to frame.
pub struct Tracker {
    region: Region,
    template: Vec<f32>,
    template_width: usize,
    template_height: usize,
}

impl Frame<'_> {
    /// The grey at a point, between pixels by blending the four around it;
    /// outside the frame, its nearest edge's.
    fn sample(&self, x: f64, y: f64) -> f32 {
        let max_x = (self.width - 1) as f64;
        let max_y = (self.height - 1) as f64;
        let x = x.clamp(0.0, max_x);
        let y = y.clamp(0.0, max_y);
        let (x0, y0) = (x.floor() as usize, y.floor() as usize);
        let (x1, y1) = ((x0 + 1).min(self.width - 1), (y0 + 1).min(self.height - 1));
        let (fx, fy) = ((x - x0 as f64) as f32, (y - y0 as f64) as f32);
        let at = |x: usize, y: usize| self.pixels[y * self.width + x];
        let top = at(x0, y0) * (1.0 - fx) + at(x1, y0) * fx;
        let bottom = at(x0, y1) * (1.0 - fx) + at(x1, y1) * fx;
        top * (1.0 - fy) + bottom * fy
    }

    /// A patch `width` by `height` of these pixels, centred at a point, each
    /// `step` of the frame's pixels apart.
    fn patch(
        &self,
        center_x: f64,
        center_y: f64,
        step: f64,
        width: usize,
        height: usize,
    ) -> Vec<f32> {
        let mut patch = Vec::with_capacity(width * height);
        for v in 0..height {
            let y = center_y + (v as f64 + 0.5 - height as f64 / 2.0) * step;
            for u in 0..width {
                let x = center_x + (u as f64 + 0.5 - width as f64 / 2.0) * step;
                patch.push(self.sample(x, y));
            }
        }
        patch
    }
}

/// The normalised cross-correlation of two patches of the same size: 1 for
/// the same picture (whatever its brightness and contrast), 0 for unrelated
/// ones; 0 if either is flat.
fn correlation(a: &[f32], b: &[f32]) -> f64 {
    let n = a.len() as f64;
    let mean_a = a.iter().map(|&value| f64::from(value)).sum::<f64>() / n;
    let mean_b = b.iter().map(|&value| f64::from(value)).sum::<f64>() / n;
    let (mut cross, mut var_a, mut var_b) = (0.0, 0.0, 0.0);
    for (&x, &y) in a.iter().zip(b) {
        let (x, y) = (f64::from(x) - mean_a, f64::from(y) - mean_b);
        cross += x * y;
        var_a += x * x;
        var_b += y * y;
    }
    if var_a <= 1e-12 || var_b <= 1e-12 {
        return 0.0;
    }
    cross / (var_a * var_b).sqrt()
}

/// Where a parabola through three values peaks, from -0.5 to 0.5 around the
/// middle one.
fn peak_offset(before: f64, middle: f64, after: f64) -> f64 {
    let curvature = before - 2.0 * middle + after;
    if curvature >= 0.0 {
        return 0.0;
    }
    (0.5 * (before - after) / curvature).clamp(-0.5, 0.5)
}

impl Tracker {
    /// Starts following `region`, as it is on `frame`.
    pub fn new(frame: &Frame<'_>, region: Region) -> Self {
        let (template_width, template_height) = template_size(&region);
        let step = region.width / template_width as f64;
        let template = frame.patch(
            region.center_x,
            region.center_y,
            step,
            template_width,
            template_height,
        );
        Self {
            region,
            template,
            template_width,
            template_height,
        }
    }

    /// Where the region was last found.
    pub fn region(&self) -> Region {
        self.region
    }

    /// Finds the region on the next frame: none once it's lost.
    pub fn track(&mut self, frame: &Frame<'_>) -> Option<Found> {
        let (tw, th) = (self.template_width, self.template_height);
        let reach = (SEARCH * tw.max(th) as f64).round() as usize;
        let mut best: Option<(f64, f64, f64, f64)> = None; // score, x, y, scale
        for scale in SCALES {
            let step = self.region.width * scale / tw as f64;
            // The search area at the template's resolution, the region's old
            // middle at its middle.
            let (sw, sh) = (tw + 2 * reach, th + 2 * reach);
            let area = frame.patch(self.region.center_x, self.region.center_y, step, sw, sh);
            let scores = slide(&area, sw, &self.template, tw, th, reach);
            let side = 2 * reach + 1;
            let (index, &score) = scores
                .iter()
                .enumerate()
                .max_by(|a, b| a.1.total_cmp(b.1))
                .expect("a search area");
            let (ix, iy) = (index % side, index / side);
            // A fraction of a pixel more, from the scores either side.
            let at = |x: usize, y: usize| scores[y * side + x];
            let fx = if ix > 0 && ix + 1 < side {
                peak_offset(at(ix - 1, iy), score, at(ix + 1, iy))
            } else {
                0.0
            };
            let fy = if iy > 0 && iy + 1 < side {
                peak_offset(at(ix, iy - 1), score, at(ix, iy + 1))
            } else {
                0.0
            };
            let dx = (ix as f64 + fx - reach as f64) * step;
            let dy = (iy as f64 + fy - reach as f64) * step;
            if best.is_none_or(|(best_score, ..)| score > best_score) {
                best = Some((
                    score,
                    self.region.center_x + dx,
                    self.region.center_y + dy,
                    scale,
                ));
            }
        }
        let (score, center_x, center_y, scale) = best?;
        if score < LOST {
            return None;
        }
        self.region = Region {
            center_x,
            center_y,
            width: self.region.width * scale,
            height: self.region.height * scale,
        };
        if score > SURE {
            let step = self.region.width / tw as f64;
            let found = frame.patch(center_x, center_y, step, tw, th);
            for (kept, new) in self.template.iter_mut().zip(found) {
                *kept += (new - *kept) * LEARNING;
            }
        }
        Some(Found {
            region: self.region,
            confidence: score,
        })
    }
}

/// The template's size, its longer side `TEMPLATE_SIZE`, shaped as the region.
fn template_size(region: &Region) -> (usize, usize) {
    let longer = region.width.max(region.height).max(1.0);
    let width = ((region.width / longer) * TEMPLATE_SIZE as f64)
        .round()
        .max(4.0) as usize;
    let height = ((region.height / longer) * TEMPLATE_SIZE as f64)
        .round()
        .max(4.0) as usize;
    (width, height)
}

/// The template's correlation with the area at each offset, from `-reach` to
/// `reach` either way, row by row.
fn slide(
    area: &[f32],
    area_width: usize,
    template: &[f32],
    tw: usize,
    th: usize,
    reach: usize,
) -> Vec<f64> {
    let side = 2 * reach + 1;
    let mut window = vec![0.0f32; tw * th];
    let mut scores = Vec::with_capacity(side * side);
    for oy in 0..side {
        for ox in 0..side {
            for v in 0..th {
                let row = (oy + v) * area_width + ox;
                window[v * tw..(v + 1) * tw].copy_from_slice(&area[row..row + tw]);
            }
            scores.push(correlation(template, &window));
        }
    }
    scores
}

#[cfg(test)]
mod tests {
    use super::{Frame, Region, Tracker};

    /// A repeatable noise from 0 to 1.
    fn noise(x: usize, y: usize, seed: usize) -> f32 {
        let mut value = (x * 73_856_093) ^ (y * 19_349_663) ^ (seed * 83_492_791);
        value ^= value >> 13;
        value = value.wrapping_mul(0x5bd1_e995);
        value ^= value >> 15;
        (value % 1000) as f32 / 1000.0
    }

    /// A noisy background with a textured square on it, `side` pixels, its
    /// middle at a point.
    fn picture(
        width: usize,
        height: usize,
        center: (f64, f64),
        side: f64,
        with_square: bool,
    ) -> Vec<f32> {
        let mut pixels = Vec::with_capacity(width * height);
        for y in 0..height {
            for x in 0..width {
                let (dx, dy) = (x as f64 - center.0, y as f64 - center.1);
                let inside = with_square && dx.abs() < side / 2.0 && dy.abs() < side / 2.0;
                pixels.push(if inside {
                    // The square's own pattern, smooth as a picture is, moving
                    // and growing with it.
                    let (u, v) = (dx / side, dy / side);
                    let tau = std::f64::consts::TAU;
                    (0.5 + 0.25 * (tau * 2.0 * u).sin() * (tau * 1.5 * v).cos()
                        + 0.15 * (tau * (u + 2.0 * v)).sin()) as f32
                } else {
                    0.3 + 0.4 * noise(x, y, 1)
                });
            }
        }
        pixels
    }

    #[test]
    fn follows_a_square_moving_and_growing() {
        let (width, height) = (160, 120);
        let start = (40.0, 40.0);
        let first = picture(width, height, start, 30.0, true);
        let region = Region {
            center_x: start.0,
            center_y: start.1,
            width: 30.0,
            height: 30.0,
        };
        let mut tracker = Tracker::new(
            &Frame {
                width,
                height,
                pixels: &first,
            },
            region,
        );
        for i in 1..=30 {
            let center = (start.0 + 2.0 * i as f64, start.1 + 1.0 * i as f64);
            let side = 30.0 * (1.0 + 0.005 * i as f64);
            let pixels = picture(width, height, center, side, true);
            let found = tracker
                .track(&Frame {
                    width,
                    height,
                    pixels: &pixels,
                })
                .unwrap_or_else(|| panic!("lost on frame {i}"));
            let error = (found.region.center_x - center.0).hypot(found.region.center_y - center.1);
            assert!(
                error < 1.5,
                "frame {i}: {:?}, the square at {center:?}",
                found.region
            );
            assert!(found.confidence > 0.6, "frame {i}: {}", found.confidence);
        }
        let size = tracker.region().width;
        assert!((size - 30.0 * 1.15).abs() < 3.0, "size {size}");
    }

    #[test]
    fn says_when_it_has_lost_the_region() {
        let (width, height) = (160, 120);
        let first = picture(width, height, (60.0, 60.0), 30.0, true);
        let region = Region {
            center_x: 60.0,
            center_y: 60.0,
            width: 30.0,
            height: 30.0,
        };
        let mut tracker = Tracker::new(
            &Frame {
                width,
                height,
                pixels: &first,
            },
            region,
        );
        let gone = picture(width, height, (60.0, 60.0), 30.0, false);
        assert!(
            tracker
                .track(&Frame {
                    width,
                    height,
                    pixels: &gone
                })
                .is_none()
        );
    }
}
