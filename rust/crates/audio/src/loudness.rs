//! Loudness as ITU-R BS.1770-4 measures it, for EBU R128: the sound
//! K-weighted (a high shelf for the head, then a high-pass), its mean square
//! over 400 ms blocks every 100 ms, the blocks under -70 LUFS left out, then
//! those 10 LU under the rest. The true peak is the loudest sample 4x
//! oversampled (Annex 2), and the loudness range is EBU Tech 3342's. The sums
//! are kept in 100 ms steps, each sample added in turn, so the result is the
//! same however the sound is split into blocks.

use std::collections::VecDeque;
use std::f64::consts::PI;

use crate::biquad::{Coefficients, FilterBank};

/// Added to 10 log10 of the weighted mean square: a 1 kHz sine at 0 dBFS in
/// one channel reads -3.01 LUFS.
const OFFSET: f64 = -0.691;
/// Under this, LUFS, a block is silence.
const ABSOLUTE_GATE: f64 = -70.0;
/// LU under the mean of the blocks over the absolute gate: the integrated
/// loudness's relative gate, and the loudness range's.
const RELATIVE_GATE: f64 = -10.0;
const RANGE_GATE: f64 = -20.0;
/// A gating block and a short-term window, in 100 ms steps.
const BLOCK_STEPS: usize = 4;
const SHORT_TERM_STEPS: usize = 30;
/// The loudness range runs between these percentiles of the short-term
/// loudness.
const RANGE_LOW: f64 = 0.10;
const RANGE_HIGH: f64 = 0.95;

/// Measures a sound's loudness as it streams through, a block at a time.
pub struct LoudnessMeter {
    channels: usize,
    /// Each channel's weight: 1, but the LFE none and the surrounds 1.41.
    weights: Vec<f64>,
    k_weighting: FilterBank,
    /// Samples in a 100 ms step.
    step: usize,
    /// Samples into the current step, and each channel's sum of squares
    /// over them.
    filled: usize,
    sums: Vec<f64>,
    /// The last steps' weighted sums of squares, oldest first, as many as a
    /// short-term window.
    recent: VecDeque<f64>,
    /// The weighted mean squares of the gating blocks and the short-term
    /// windows over the absolute gate.
    blocks: Vec<f64>,
    windows: Vec<f64>,
    peaks: Vec<TruePeak>,
    /// The block being K-weighted, kept between pushes.
    scratch: Vec<Vec<f32>>,
}

impl LoudnessMeter {
    /// Six channels are taken as 5.1, in the order L R C LFE Ls Rs.
    pub fn new(sample_rate: u32, channel_count: usize) -> Self {
        let sample_rate = sample_rate.max(1);
        let weights = (0..channel_count)
            .map(|channel| match (channel_count, channel) {
                (6, 3) => 0.0,
                (6, 4 | 5) => 1.41,
                _ => 1.0,
            })
            .collect();
        let k_weighting = k_weighting(f64::from(sample_rate))
            .into_iter()
            .map(Coefficients::from_normalised)
            .collect();
        LoudnessMeter {
            channels: channel_count,
            weights,
            k_weighting: FilterBank::new(k_weighting, channel_count),
            // As libebur128 rounds it, for rates that aren't a multiple of 10.
            step: ((sample_rate as usize + 5) / 10).max(1),
            filled: 0,
            sums: vec![0.0; channel_count],
            recent: VecDeque::with_capacity(SHORT_TERM_STEPS),
            blocks: Vec::new(),
            windows: Vec::new(),
            peaks: (0..channel_count).map(|_| TruePeak::new()).collect(),
            scratch: vec![Vec::new(); channel_count],
        }
    }

    /// The next block, one slice per channel, all the same length, of any
    /// size.
    ///
    /// # Panics
    /// If there aren't as many slices as the meter's channels, or they differ
    /// in length.
    pub fn push(&mut self, channels: &[&[f32]]) {
        assert_eq!(channels.len(), self.channels, "one slice per channel");
        let length = channels.first().map_or(0, |channel| channel.len());
        assert!(
            channels.iter().all(|channel| channel.len() == length),
            "the channels' lengths differ"
        );
        if length == 0 {
            return;
        }
        for (peak, samples) in self.peaks.iter_mut().zip(channels) {
            peak.push(samples);
        }
        for (scratch, samples) in self.scratch.iter_mut().zip(channels) {
            scratch.clear();
            scratch.extend_from_slice(samples);
        }
        self.k_weighting.process(&mut self.scratch);

        let mut done = 0;
        while done < length {
            let end = (done + self.step - self.filled).min(length);
            for (sum, samples) in self.sums.iter_mut().zip(&self.scratch) {
                for &sample in &samples[done..end] {
                    *sum += f64::from(sample) * f64::from(sample);
                }
            }
            self.filled += end - done;
            done = end;
            if self.filled == self.step {
                self.end_step();
            }
        }
    }

    /// The integrated loudness, LUFS: None until there's a whole 400 ms
    /// block over the absolute gate.
    pub fn integrated(&self) -> Option<f64> {
        let gate = mean(&self.blocks)? * power(RELATIVE_GATE);
        let (sum, count) = self
            .blocks
            .iter()
            .filter(|&&block| block > gate)
            .fold((0.0, 0usize), |(sum, count), block| {
                (sum + block, count + 1)
            });
        (count > 0).then(|| loudness(sum / count as f64))
    }

    /// The true peak, dBTP: the loudest channel's, as if the sound went on
    /// in silence. Never under the sample peak; -inf for silence.
    pub fn true_peak(&self) -> f64 {
        let peak = self.peaks.iter().map(TruePeak::peak).fold(0.0, f64::max);
        20.0 * peak.log10()
    }

    /// The loudness range, LU (EBU Tech 3342): from the 10th to the 95th
    /// percentile of the 3 s short-term loudness, every 100 ms, gated at
    /// -70 LUFS and 20 LU under the mean. None until there's a window over
    /// the gate.
    pub fn loudness_range(&self) -> Option<f64> {
        let gate = mean(&self.windows)? * power(RANGE_GATE);
        let mut kept: Vec<f64> = self
            .windows
            .iter()
            .copied()
            .filter(|&window| window > gate)
            .collect();
        if kept.is_empty() {
            return None;
        }
        kept.sort_by(f64::total_cmp);
        let at = |share: f64| kept[((kept.len() - 1) as f64 * share).round() as usize];
        Some(loudness(at(RANGE_HIGH)) - loudness(at(RANGE_LOW)))
    }

    /// A 100 ms step is complete: the block and the window that end with it.
    fn end_step(&mut self) {
        let sum = self
            .sums
            .iter()
            .zip(&self.weights)
            .map(|(sum, weight)| sum * weight)
            .sum();
        self.sums.fill(0.0);
        self.filled = 0;
        if self.recent.len() == SHORT_TERM_STEPS {
            self.recent.pop_front();
        }
        self.recent.push_back(sum);
        let silence = power(ABSOLUTE_GATE - OFFSET);
        if let Some(block) = self.mean_square(BLOCK_STEPS)
            && block > silence
        {
            self.blocks.push(block);
        }
        if let Some(window) = self.mean_square(SHORT_TERM_STEPS)
            && window > silence
        {
            self.windows.push(window);
        }
    }

    /// The weighted mean square over the last steps, once there are as many.
    fn mean_square(&self, steps: usize) -> Option<f64> {
        let skip = self.recent.len().checked_sub(steps)?;
        let sum: f64 = self.recent.iter().skip(skip).sum();
        Some(sum / (steps * self.step) as f64)
    }
}

/// The K-weighting's two stages at a sample rate, as [b0, b1, b2, a1, a2]:
/// the standard's analogue prototypes through the bilinear transform, as
/// libebur128 designs them, so they hold at any rate. At 48 kHz they're the
/// standard's table.
fn k_weighting(sample_rate: f64) -> [[f64; 5]; 2] {
    // The head's effect: a high shelf of about 4 dB above 1.5 kHz.
    let frequency = 1_681.974_450_955_533;
    let gain = 3.999_843_853_973_347;
    let q = 0.707_175_236_955_419_6;
    let k = (PI * frequency / sample_rate).tan();
    let vh = 10f64.powf(gain / 20.0);
    let vb = vh.powf(0.499_666_774_154_541_6);
    let a0 = 1.0 + k / q + k * k;
    let shelf = [
        (vh + vb * k / q + k * k) / a0,
        2.0 * (k * k - vh) / a0,
        (vh - vb * k / q + k * k) / a0,
        2.0 * (k * k - 1.0) / a0,
        (1.0 - k / q + k * k) / a0,
    ];
    // The revised low-frequency B-curve: a high-pass at about 38 Hz. Its
    // numerator is 1, -2, 1 as the standard gives it, not normalised.
    let frequency = 38.135_470_876_024_44;
    let q = 0.500_327_037_323_877_3;
    let k = (PI * frequency / sample_rate).tan();
    let a0 = 1.0 + k / q + k * k;
    let high_pass = [
        1.0,
        -2.0,
        1.0,
        2.0 * (k * k - 1.0) / a0,
        (1.0 - k / q + k * k) / a0,
    ];
    [shelf, high_pass]
}

fn mean(values: &[f64]) -> Option<f64> {
    (!values.is_empty()).then(|| values.iter().sum::<f64>() / values.len() as f64)
}

/// A weighted mean square as LUFS.
fn loudness(mean_square: f64) -> f64 {
    OFFSET + 10.0 * mean_square.log10()
}

/// dB as a power ratio.
fn power(db: f64) -> f64 {
    10f64.powf(db / 10.0)
}

/// Taps in each of the interpolation filter's phases.
const TAPS: usize = 12;

/// BS.1770-4 Annex 2's 48-tap interpolation filter, in its four phases: the
/// sound 4x oversampled is y[4n + p] = Σ PHASES[p][j] · x[n - j]. Each phase
/// falls between two input samples, an eighth, three eighths, five and seven
/// eighths of the way.
const PHASES: [[f64; TAPS]; 4] = [
    [
        0.001_708_984_375,
        0.010_986_328_125,
        -0.019_653_320_312_5,
        0.033_203_125,
        -0.059_448_242_187_5,
        0.137_329_101_562_5,
        0.972_167_968_75,
        -0.102_294_921_875,
        0.047_607_421_875,
        -0.026_611_328_125,
        0.014_892_578_125,
        -0.008_300_781_25,
    ],
    [
        -0.029_174_804_687_5,
        0.029_296_875,
        -0.051_757_812_5,
        0.089_111_328_125,
        -0.166_503_906_25,
        0.465_087_890_625,
        0.779_785_156_25,
        -0.200_317_382_812_5,
        0.101_562_5,
        -0.058_227_539_062_5,
        0.033_081_054_687_5,
        -0.018_920_898_437_5,
    ],
    [
        -0.018_920_898_437_5,
        0.033_081_054_687_5,
        -0.058_227_539_062_5,
        0.101_562_5,
        -0.200_317_382_812_5,
        0.779_785_156_25,
        0.465_087_890_625,
        -0.166_503_906_25,
        0.089_111_328_125,
        -0.051_757_812_5,
        0.029_296_875,
        -0.029_174_804_687_5,
    ],
    [
        -0.008_300_781_25,
        0.014_892_578_125,
        -0.026_611_328_125,
        0.047_607_421_875,
        -0.102_294_921_875,
        0.972_167_968_75,
        0.137_329_101_562_5,
        -0.059_448_242_187_5,
        0.033_203_125,
        -0.019_653_320_312_5,
        0.010_986_328_125,
        0.001_708_984_375,
    ],
];

/// A channel's true peak so far.
struct TruePeak {
    /// The samples since the last push's last `TAPS - 1`, which the filter
    /// still needs.
    buffer: Vec<f32>,
    /// Linear, of the samples and what's interpolated between them.
    peak: f64,
}

impl TruePeak {
    fn new() -> Self {
        TruePeak {
            buffer: vec![0.0; TAPS - 1],
            peak: 0.0,
        }
    }

    fn push(&mut self, samples: &[f32]) {
        self.buffer.extend_from_slice(samples);
        self.peak = self.peak.max(scan(&self.buffer));
        self.buffer.drain(..samples.len());
    }

    /// With the last samples' interpolation, as if silence followed.
    fn peak(&self) -> f64 {
        let mut tail = self.buffer.clone();
        tail.resize(2 * (TAPS - 1), 0.0);
        self.peak.max(scan(&tail))
    }
}

/// The highest absolute value of the samples after the first `TAPS - 1` and
/// of the four interpolated as each comes in.
fn scan(buffer: &[f32]) -> f64 {
    buffer.windows(TAPS).fold(0.0, |peak, window| {
        let mut peak = peak.max(f64::from(window[TAPS - 1]).abs());
        for phase in &PHASES {
            let value: f64 = phase
                .iter()
                .zip(window.iter().rev())
                .map(|(tap, &sample)| tap * f64::from(sample))
                .sum();
            peak = peak.max(value.abs());
        }
        peak
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn at_48_khz_the_k_weighting_is_the_standards_table() {
        let table = [
            [
                1.535_124_859_586_97,
                -2.691_696_189_406_38,
                1.198_392_810_852_85,
                -1.690_659_293_182_41,
                0.732_480_774_215_85,
            ],
            [1.0, -2.0, 1.0, -1.990_047_454_833_98, 0.990_072_250_366_21],
        ];
        for (stage, expected) in k_weighting(48_000.0).iter().zip(&table) {
            for (value, expected) in stage.iter().zip(expected) {
                assert!((value - expected).abs() < 1e-8, "{value} {expected}");
            }
        }
    }

    #[test]
    fn the_interpolation_filter_is_symmetric() {
        for (phase, mirror) in PHASES.iter().zip(PHASES.iter().rev()) {
            let reversed: Vec<f64> = mirror.iter().rev().copied().collect();
            assert_eq!(phase.as_slice(), reversed.as_slice());
        }
    }
}
