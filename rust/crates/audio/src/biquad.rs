//! Second-order filters from Robert Bristow-Johnson's Audio EQ Cookbook. They
//! run in f64: a narrow notch at 50 Hz or a high-pass at 20 Hz puts the poles
//! so close to the unit circle that f32 would make them drift or ring.

use std::f64::consts::PI;

/// The coefficients, normalised so a0 is 1.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Coefficients {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
}

/// What to design, frequencies in Hz.
#[derive(Debug, Clone, Copy)]
pub(crate) enum Design {
    HighPass {
        frequency: f64,
        q: f64,
    },
    Notch {
        frequency: f64,
        q: f64,
    },
    Peak {
        frequency: f64,
        q: f64,
        gain: f64,
    },
    /// Shelves with the cookbook's slope S = 1, the steepest without a bump.
    LowShelf {
        frequency: f64,
        gain: f64,
    },
    HighShelf {
        frequency: f64,
        gain: f64,
    },
}

/// The highest frequency a filter is designed at, as a share of the sample
/// rate: past it the bilinear transform warps the response too much.
const HIGHEST: f64 = 0.45;

impl Coefficients {
    pub(crate) fn new(design: Design, sample_rate: f64) -> Coefficients {
        let at = |frequency: f64| frequency.clamp(1.0, sample_rate * HIGHEST);
        let omega = |frequency: f64| 2.0 * PI * at(frequency) / sample_rate;
        // (b0, b1, b2, a0, a1, a2) as the cookbook writes them.
        let (b0, b1, b2, a0, a1, a2) = match design {
            Design::HighPass { frequency, q } => {
                let (sin, cos) = omega(frequency).sin_cos();
                let alpha = sin / (2.0 * q);
                (
                    (1.0 + cos) / 2.0,
                    -(1.0 + cos),
                    (1.0 + cos) / 2.0,
                    1.0 + alpha,
                    -2.0 * cos,
                    1.0 - alpha,
                )
            }
            Design::Notch { frequency, q } => {
                let (sin, cos) = omega(frequency).sin_cos();
                let alpha = sin / (2.0 * q);
                (1.0, -2.0 * cos, 1.0, 1.0 + alpha, -2.0 * cos, 1.0 - alpha)
            }
            Design::Peak { frequency, q, gain } => {
                let (sin, cos) = omega(frequency).sin_cos();
                let alpha = sin / (2.0 * q);
                let a = 10f64.powf(gain / 40.0);
                (
                    1.0 + alpha * a,
                    -2.0 * cos,
                    1.0 - alpha * a,
                    1.0 + alpha / a,
                    -2.0 * cos,
                    1.0 - alpha / a,
                )
            }
            Design::LowShelf { frequency, gain } => {
                let (sin, cos) = omega(frequency).sin_cos();
                let a = 10f64.powf(gain / 40.0);
                // S = 1: alpha = sin/2 · sqrt(2).
                let root = 2.0 * a.sqrt() * sin / 2.0 * 2f64.sqrt();
                (
                    a * ((a + 1.0) - (a - 1.0) * cos + root),
                    2.0 * a * ((a - 1.0) - (a + 1.0) * cos),
                    a * ((a + 1.0) - (a - 1.0) * cos - root),
                    (a + 1.0) + (a - 1.0) * cos + root,
                    -2.0 * ((a - 1.0) + (a + 1.0) * cos),
                    (a + 1.0) + (a - 1.0) * cos - root,
                )
            }
            Design::HighShelf { frequency, gain } => {
                let (sin, cos) = omega(frequency).sin_cos();
                let a = 10f64.powf(gain / 40.0);
                let root = 2.0 * a.sqrt() * sin / 2.0 * 2f64.sqrt();
                (
                    a * ((a + 1.0) + (a - 1.0) * cos + root),
                    -2.0 * a * ((a - 1.0) + (a + 1.0) * cos),
                    a * ((a + 1.0) + (a - 1.0) * cos - root),
                    (a + 1.0) - (a - 1.0) * cos + root,
                    2.0 * ((a - 1.0) - (a + 1.0) * cos),
                    (a + 1.0) - (a - 1.0) * cos - root,
                )
            }
        };
        Coefficients {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b2 / a0,
            a1: a1 / a0,
            a2: a2 / a0,
        }
    }

    /// Coefficients designed elsewhere, a0 already 1: [b0, b1, b2, a1, a2].
    pub(crate) fn from_normalised([b0, b1, b2, a1, a2]: [f64; 5]) -> Coefficients {
        Coefficients { b0, b1, b2, a1, a2 }
    }

    /// The gain at a frequency, as a ratio: for tests and for drawing the
    /// curve.
    #[cfg(test)]
    pub(crate) fn magnitude(&self, frequency: f64, sample_rate: f64) -> f64 {
        let omega = 2.0 * PI * frequency / sample_rate;
        let (sin1, cos1) = omega.sin_cos();
        let (sin2, cos2) = (2.0 * omega).sin_cos();
        let (nr, ni) = (
            self.b0 + self.b1 * cos1 + self.b2 * cos2,
            -(self.b1 * sin1 + self.b2 * sin2),
        );
        let (dr, di) = (
            1.0 + self.a1 * cos1 + self.a2 * cos2,
            -(self.a1 * sin1 + self.a2 * sin2),
        );
        ((nr * nr + ni * ni) / (dr * dr + di * di)).sqrt()
    }
}

/// State this small is set to zero: as a filter's state decays in silence
/// it would otherwise reach subnormal numbers, which are slow on some CPUs.
const SUBNORMAL: f64 = 1e-30;
/// How often that's done, in samples from the start of the sound: at fixed
/// places, so the result doesn't depend on how the sound is split into
/// blocks, and not every sample, where it would slow every filter down.
const FLUSH_EVERY: u64 = 1024;

/// A cascade of biquads, with a state per channel (transposed direct form II).
pub(crate) struct FilterBank {
    coefficients: Vec<Coefficients>,
    /// Per channel, two values per filter.
    states: Vec<Vec<[f64; 2]>>,
    /// Samples processed so far.
    position: u64,
}

impl FilterBank {
    pub(crate) fn new(coefficients: Vec<Coefficients>, channels: usize) -> FilterBank {
        let states = vec![vec![[0.0; 2]; coefficients.len()]; channels];
        FilterBank {
            coefficients,
            states,
            position: 0,
        }
    }

    pub(crate) fn process(&mut self, channels: &mut [Vec<f32>]) {
        let length = channels.first().map_or(0, Vec::len);
        let mut done = 0;
        while done < length {
            let until_flush = (FLUSH_EVERY - self.position % FLUSH_EVERY) as usize;
            let end = (done + until_flush).min(length);
            for (samples, states) in channels.iter_mut().zip(&mut self.states) {
                // Each sample through every filter in turn: the filters'
                // recursions are independent, so the CPU can run them side by
                // side rather than one long chain at a time.
                for sample in &mut samples[done..end] {
                    let mut value = f64::from(*sample);
                    for (c, state) in self.coefficients.iter().zip(states.iter_mut()) {
                        let [s1, s2] = *state;
                        let y = c.b0 * value + s1;
                        *state = [c.b1 * value - c.a1 * y + s2, c.b2 * value - c.a2 * y];
                        value = y;
                    }
                    *sample = value as f32;
                }
            }
            self.position += (end - done) as u64;
            done = end;
            if self.position.is_multiple_of(FLUSH_EVERY) {
                for state in self.states.iter_mut().flatten().flatten() {
                    if state.abs() < SUBNORMAL {
                        *state = 0.0;
                    }
                }
            }
        }
    }
}

/// Q of the two sections of a 4th-order Butterworth: 1 / (2 cos(π/8)) and
/// 1 / (2 cos(3π/8)).
pub(crate) const BUTTERWORTH_4: [f64; 2] = [0.541_196_100_146_197, 1.306_562_964_876_376_7];

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: f64 = 48_000.0;

    fn db(ratio: f64) -> f64 {
        20.0 * ratio.log10()
    }

    #[test]
    fn a_peak_has_its_gain_at_its_centre() {
        for gain in [-12.0, -3.0, 6.0, 15.0] {
            let c = Coefficients::new(
                Design::Peak {
                    frequency: 1000.0,
                    q: 2.0,
                    gain,
                },
                RATE,
            );
            assert!((db(c.magnitude(1000.0, RATE)) - gain).abs() < 1e-6);
            assert!(db(c.magnitude(20.0, RATE)).abs() < 0.1);
        }
    }

    #[test]
    fn shelves_reach_their_gain() {
        let low = Coefficients::new(
            Design::LowShelf {
                frequency: 200.0,
                gain: 6.0,
            },
            RATE,
        );
        assert!((db(low.magnitude(10.0, RATE)) - 6.0).abs() < 0.05);
        assert!(db(low.magnitude(10_000.0, RATE)).abs() < 0.05);
        assert!((db(low.magnitude(200.0, RATE)) - 3.0).abs() < 0.05);
        let high = Coefficients::new(
            Design::HighShelf {
                frequency: 5000.0,
                gain: -9.0,
            },
            RATE,
        );
        assert!((db(high.magnitude(22_000.0, RATE)) + 9.0).abs() < 0.2);
        assert!(db(high.magnitude(50.0, RATE)).abs() < 0.05);
    }

    #[test]
    fn subnormals_are_flushed() {
        let c = Coefficients::new(
            Design::HighPass {
                frequency: 80.0,
                q: 0.7,
            },
            RATE,
        );
        let mut bank = FilterBank::new(vec![c], 1);
        let mut signal = vec![vec![1.0f32; 100]];
        bank.process(&mut signal);
        for _ in 0..2000 {
            let mut silence = vec![vec![0.0f32; 4800]];
            bank.process(&mut silence);
        }
        assert_eq!(bank.states[0][0], [0.0, 0.0]);
    }
}
