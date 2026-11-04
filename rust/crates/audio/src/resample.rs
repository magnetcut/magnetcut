//! Changing a sound's sample rate, as it streams: band-limited interpolation
//! with a Kaiser-windowed sinc, its kernel tabulated at a few hundred
//! fractional positions and interpolated linearly between them. Output
//! sample n is the input at time (n · from + offset) / to, in input samples,
//! worked out in integers so it's exact however long the sound and however
//! it's split into blocks.

use std::f64::consts::PI;
use std::sync::Arc;

/// Zero crossings of the sinc on each side, at the lower of the two rates.
const HALF_WIDTH: f64 = 32.0;
/// The cutoff, as a share of the lower rate's Nyquist frequency. With the
/// kernel above it's flat to about 0.83 of it and 80 dB down by 0.99.
const ROLLOFF: f64 = 0.91;
/// The Kaiser window's beta: about 80 dB of stopband.
const BETA: f64 = 8.0;
/// Fractional positions in the table.
const PHASES: usize = 512;

/// The kernel, shared by the channels.
pub(crate) struct Kernel {
    /// Input samples on each side of the output's position.
    half: usize,
    /// `PHASES + 1` rows of `2 · half` taps: row p is for a position p /
    /// PHASES past an input sample, its taps for the input samples from
    /// `half - 1` before it to `half` after.
    table: Vec<f32>,
}

impl Kernel {
    fn new(from: u32, to: u32) -> Kernel {
        // Down to a lower rate, the cutoff is that rate's: the kernel is
        // wider in input samples.
        let scale = (f64::from(to) / f64::from(from)).min(1.0);
        let cutoff = 0.5 * ROLLOFF * scale;
        let half = (HALF_WIDTH / scale).ceil() as usize;
        let taps = 2 * half;
        let mut table = vec![0.0f32; (PHASES + 1) * taps];
        for (p, row) in table.chunks_exact_mut(taps).enumerate() {
            let fraction = p as f64 / PHASES as f64;
            let values: Vec<f64> = (0..taps)
                .map(|j| {
                    // How far the input sample is from the output's position.
                    let distance = fraction - (j as f64 - (half as f64 - 1.0));
                    let window = kaiser(distance / half as f64);
                    2.0 * cutoff * sinc(2.0 * cutoff * distance) * window
                })
                .collect();
            // Each row adds up to 1, so a constant passes exactly.
            let sum: f64 = values.iter().sum();
            for (tap, value) in row.iter_mut().zip(values) {
                *tap = (value / sum) as f32;
            }
        }
        Kernel { half, table }
    }
}

fn sinc(x: f64) -> f64 {
    if x.abs() < 1e-12 {
        1.0
    } else {
        (PI * x).sin() / (PI * x)
    }
}

/// The Kaiser window at x from -1 to 1.
fn kaiser(x: f64) -> f64 {
    let inside = (1.0 - x * x).max(0.0);
    bessel_i0(BETA * inside.sqrt()) / bessel_i0(BETA)
}

/// The modified Bessel function of the first kind, order 0, by its series.
fn bessel_i0(x: f64) -> f64 {
    let quarter = x * x / 4.0;
    let (mut sum, mut term) = (1.0, 1.0);
    for k in 1..64 {
        term *= quarter / (k * k) as f64;
        sum += term;
        if term < sum * 1e-17 {
            break;
        }
    }
    sum
}

/// One channel's resampler.
pub(crate) struct Resampler {
    /// None when the rates are the same and there's no offset: a copy.
    kernel: Option<Arc<Kernel>>,
    from: u64,
    to: u64,
    /// The input kept, from absolute index `first`.
    history: Vec<f32>,
    first: i64,
    /// The next output's position: input sample `base` plus `remainder / to`.
    base: i64,
    remainder: u64,
}

impl Resampler {
    /// A resampler, and its kernel to share with the other channels'.
    /// `offset` moves every output's position by `offset / to` input samples.
    pub(crate) fn new(from: u32, to: u32, offset: i64, kernel: Option<Arc<Kernel>>) -> Resampler {
        let (from64, to64) = (u64::from(from), u64::from(to));
        let kernel = if from == to && offset.rem_euclid(to as i64) == 0 {
            None
        } else {
            Some(kernel.unwrap_or_else(|| Arc::new(Kernel::new(from, to))))
        };
        let base = offset.div_euclid(to as i64);
        let remainder = offset.rem_euclid(to as i64) as u64;
        // Before the sound starts is silence.
        let half = kernel.as_ref().map_or(0, |kernel| kernel.half as i64);
        let first = (base - half + 1).min(0);
        Resampler {
            kernel,
            from: from64,
            to: to64,
            history: vec![0.0; (-first) as usize],
            first,
            base,
            remainder,
        }
    }

    pub(crate) fn kernel(&self) -> Option<Arc<Kernel>> {
        self.kernel.clone()
    }

    /// Input samples after an output's position that it needs.
    pub(crate) fn lookahead(&self) -> usize {
        self.kernel.as_ref().map_or(0, |kernel| kernel.half)
    }

    /// Takes in samples and appends the output they make possible.
    pub(crate) fn process(&mut self, input: &[f32], output: &mut Vec<f32>) {
        let Some(kernel) = &self.kernel else {
            // The same rate and a whole number of samples' offset: a delay.
            self.history.extend_from_slice(input);
            let mut available = self.first + self.history.len() as i64;
            while self.base < available {
                let index = self.base - self.first;
                output.push(if index < 0 {
                    0.0
                } else {
                    self.history[index as usize]
                });
                self.base += 1;
                available = self.first + self.history.len() as i64;
            }
            self.forget(self.base);
            return;
        };
        self.history.extend_from_slice(input);
        let half = kernel.half as i64;
        let taps = 2 * kernel.half;
        let last = self.first + self.history.len() as i64 - 1;
        let step = self.from / self.to;
        let step_remainder = self.from % self.to;
        while self.base + half <= last {
            let start = (self.base - half + 1 - self.first) as usize;
            let samples = &self.history[start..start + taps];
            let position = self.remainder * PHASES as u64;
            let phase = (position / self.to) as usize;
            let blend = (position % self.to) as f32 / self.to as f32;
            let row = &kernel.table[phase * taps..(phase + 2) * taps];
            let (a, b) = dot2(samples, &row[..taps], &row[taps..]);
            output.push(a + blend * (b - a));
            self.base += step as i64;
            self.remainder += step_remainder;
            if self.remainder >= self.to {
                self.remainder -= self.to;
                self.base += 1;
            }
        }
        self.forget(self.base - half + 1);
    }

    /// Drops the input before an absolute index, now and then.
    fn forget(&mut self, before: i64) {
        let drop = before - self.first;
        if drop > 4096 {
            self.history.drain(..drop as usize);
            self.first = before;
        }
    }
}

/// The samples against two rows of taps, in running sums the compiler can
/// keep side by side.
fn dot2(samples: &[f32], a: &[f32], b: &[f32]) -> (f32, f32) {
    let mut sums_a = [0.0f32; 8];
    let mut sums_b = [0.0f32; 8];
    let chunks = samples
        .chunks_exact(8)
        .zip(a.chunks_exact(8))
        .zip(b.chunks_exact(8));
    for ((s, a), b) in chunks {
        for lane in 0..8 {
            sums_a[lane] += s[lane] * a[lane];
            sums_b[lane] += s[lane] * b[lane];
        }
    }
    let rest = samples.len() / 8 * 8;
    let mut total_a: f32 = sums_a.iter().sum();
    let mut total_b: f32 = sums_b.iter().sum();
    for n in rest..samples.len() {
        total_a += samples[n] * a[n];
        total_b += samples[n] * b[n];
    }
    (total_a, total_b)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(frequency: f64, rate: f64, length: usize, delay: f64) -> Vec<f32> {
        (0..length)
            .map(|n| (2.0 * PI * frequency * (n as f64 - delay) / rate).sin() as f32 * 0.5)
            .collect()
    }

    fn worst_error(a: &[f32], b: &[f32]) -> f32 {
        a.iter()
            .zip(b)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0, f32::max)
    }

    #[test]
    fn a_sine_comes_out_at_the_new_rate() {
        for (from, to) in [
            (44_100, 48_000),
            (48_000, 44_100),
            (22_050, 48_000),
            (96_000, 48_000),
            (48_000, 8_000),
        ] {
            let length = from as usize;
            let input = sine(1000.0, f64::from(from), length, 0.0);
            let mut resampler = Resampler::new(from, to, 0, None);
            let mut output = Vec::new();
            resampler.process(&input, &mut output);
            let expected = sine(1000.0, f64::from(to), output.len(), 0.0);
            // Away from the start, where the input jumps out of silence.
            let skip = to as usize / 100;
            let error = worst_error(&output[skip..], &expected[skip..]);
            assert!(error < 1e-3, "{from} to {to}: {error}");
        }
    }

    #[test]
    fn blocks_of_any_size_give_the_same() {
        let input = sine(3000.0, 44_100.0, 20_000, 0.0);
        let mut whole = Vec::new();
        Resampler::new(44_100, 48_000, -12_345, None).process(&input, &mut whole);
        let mut resampler = Resampler::new(44_100, 48_000, -12_345, None);
        let mut pieces = Vec::new();
        let mut at = 0;
        for size in [1, 7, 128, 3000, 1, 4999].into_iter().cycle() {
            if at >= input.len() {
                break;
            }
            let end = (at + size).min(input.len());
            resampler.process(&input[at..end], &mut pieces);
            at = end;
        }
        assert_eq!(whole, pieces);
    }

    #[test]
    fn an_offset_moves_the_sound() {
        // Half a sample at 44.1 kHz later: the output is the sine from half a
        // sample earlier.
        let input = sine(500.0, 44_100.0, 10_000, 0.0);
        let mut output = Vec::new();
        Resampler::new(44_100, 44_100, -22_050, None).process(&input, &mut output);
        let expected = sine(500.0, 44_100.0, output.len(), 0.5);
        let error = worst_error(&output[200..], &expected[200..]);
        assert!(error < 1e-3, "{error}");
    }
}
