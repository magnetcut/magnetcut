//! Changing audio's speed without changing its pitch: WSOLA (waveform
//! similarity overlap-add). Short windows of the input are laid out at a
//! different spacing than they were read at, each one nudged within a small
//! range to where its waveform best continues the one before, then
//! cross-faded. Every channel uses the same windows, found on their mix, so
//! a stereo image doesn't drift apart.

use std::f32::consts::PI;

/// A window, in seconds: long enough to hold a few periods of a low voice,
/// short enough not to smear transients.
const WINDOW_SECONDS: f64 = 0.03;
/// How far a window may move from where it ideally falls, each way.
const SEEK_SECONDS: f64 = 0.012;
/// The coarse search looks at every this many samples, then refines.
const COARSE_STEP: usize = 4;

pub struct TimeStretchOptions<'a> {
    /// One slice per channel, all the same length.
    pub channels: &'a [&'a [f32]],
    pub sample_rate: u32,
    /// How much faster the result plays: 2 takes half as long, 0.5 twice.
    pub tempo: f64,
    /// Samples per channel in the result; past the input's end is silence.
    pub output_length: usize,
}

pub fn time_stretch(
    TimeStretchOptions {
        channels,
        sample_rate,
        tempo,
        output_length,
    }: TimeStretchOptions,
) -> Vec<Vec<f32>> {
    let input_length = channels.first().map_or(0, |channel| channel.len());
    if channels.is_empty() || input_length == 0 || tempo.is_nan() || tempo <= 0.0 {
        return vec![vec![0.0; output_length]; channels.len().max(1)];
    }
    if (tempo - 1.0).abs() < 1e-9 {
        return channels
            .iter()
            .map(|channel| {
                (0..output_length)
                    .map(|i| sample(channel, i as isize))
                    .collect()
            })
            .collect();
    }

    let window = even((sample_rate as f64 * WINDOW_SECONDS) as usize).max(16);
    let hop_out = window / 2;
    let hop_in = hop_out as f64 * tempo;
    let seek = (sample_rate as f64 * SEEK_SECONDS) as isize;
    // A periodic Hann window: shifted by half its length, two of them add up to 1.
    let weights: Vec<f32> = (0..window)
        .map(|n| 0.5 - 0.5 * (2.0 * PI * n as f32 / window as f32).cos())
        .collect();
    let mix = mixdown(channels);
    let coarse: Vec<f32> = mix.iter().step_by(COARSE_STEP).copied().collect();

    let mut outputs = vec![vec![0.0f32; output_length + window]; channels.len()];
    let mut total_weight = vec![0.0f32; output_length + window];
    // Where the previous window was read from: the next one should continue it.
    let mut previous: Option<isize> = None;
    // Each window covers two hops: the last one starts before the end.
    let frames = output_length.div_ceil(hop_out);
    for frame in 0..frames {
        let ideal = (frame as f64 * hop_in).round() as isize;
        let start = match previous {
            None => ideal,
            Some(previous) => best_offset(BestOffsetOptions {
                mix: &mix,
                coarse: &coarse,
                target: previous + hop_out as isize,
                ideal,
                seek,
                length: hop_out,
            }),
        };
        let at = frame * hop_out;
        let inside = start >= 0 && start as usize + window <= input_length;
        for (channel, output) in channels.iter().zip(outputs.iter_mut()) {
            let output = &mut output[at..at + window];
            if inside {
                let input = &channel[start as usize..start as usize + window];
                for ((out, value), weight) in output.iter_mut().zip(input).zip(&weights) {
                    *out += value * weight;
                }
            } else {
                for (n, (out, weight)) in output.iter_mut().zip(&weights).enumerate() {
                    *out += sample(channel, start + n as isize) * weight;
                }
            }
        }
        for (n, weight) in weights.iter().enumerate() {
            total_weight[at + n] += weight;
        }
        previous = Some(start);
    }

    // Dividing by the weights there are restores full level where fewer than
    // two windows overlap: the very start.
    for output in &mut outputs {
        for (value, weight) in output.iter_mut().zip(&total_weight) {
            *value = if *weight > 1e-9 { *value / weight } else { 0.0 };
        }
        output.truncate(output_length);
    }
    outputs
}

struct BestOffsetOptions<'a> {
    mix: &'a [f32],
    /// Every `COARSE_STEP`th sample of `mix`.
    coarse: &'a [f32],
    /// Where the input would continue the previous window seamlessly.
    target: isize,
    /// Where this window falls at the requested tempo.
    ideal: isize,
    seek: isize,
    /// How many samples to compare: the part that's cross-faded.
    length: usize,
}

/// The start within `ideal ± seek` whose waveform best matches the one at
/// `target`, by normalised cross-correlation: first every few samples (on
/// `coarse`), then around the best of those.
fn best_offset(
    BestOffsetOptions {
        mix,
        coarse,
        target,
        ideal,
        seek,
        length,
    }: BestOffsetOptions,
) -> isize {
    let step = COARSE_STEP as isize;
    let low = (ideal - seek).max(0);
    let high = (ideal + seek).max(low);

    let mut best = ideal.max(0);
    let mut best_score = f32::NEG_INFINITY;
    let coarse_target = target.max(0) / step;
    // low and high are never negative.
    for candidate in (low + step - 1) / step..=high / step {
        let score = similarity(coarse, coarse_target, candidate, length / COARSE_STEP);
        if score > best_score {
            best_score = score;
            best = candidate * step;
        }
    }

    let around = best;
    best_score = f32::NEG_INFINITY;
    for candidate in (around - step + 1).max(low)..=(around + step - 1).min(high) {
        let score = similarity(mix, target, candidate, length);
        if score > best_score {
            best_score = score;
            best = candidate;
        }
    }
    best
}

/// How alike `length` samples at `target` and at `candidate` are, scaled by
/// the candidate's energy so loud stretches don't win for being loud.
fn similarity(samples: &[f32], target: isize, candidate: isize, length: usize) -> f32 {
    let inside = |at: isize| at >= 0 && at as usize + length <= samples.len();
    let (product, energy) = if inside(target) && inside(candidate) {
        let (target, candidate) = (target as usize, candidate as usize);
        dot_and_energy(
            &samples[target..target + length],
            &samples[candidate..candidate + length],
        )
    } else {
        // Near the edges: silence outside.
        (0..length as isize).fold((0.0, 0.0), |(product, energy), n| {
            let other = sample(samples, candidate + n);
            (
                product + sample(samples, target + n) * other,
                energy + other * other,
            )
        })
    };
    product / (energy + 1e-9).sqrt()
}

/// a·b and b·b, in eight running sums the compiler can keep side by side.
fn dot_and_energy(a: &[f32], b: &[f32]) -> (f32, f32) {
    let mut products = [0.0f32; 8];
    let mut energies = [0.0f32; 8];
    let (a_chunks, b_chunks) = (a.chunks_exact(8), b.chunks_exact(8));
    let (a_rest, b_rest) = (a_chunks.remainder(), b_chunks.remainder());
    for (a, b) in a_chunks.zip(b_chunks) {
        for lane in 0..8 {
            products[lane] += a[lane] * b[lane];
            energies[lane] += b[lane] * b[lane];
        }
    }
    let mut product: f32 = products.iter().sum();
    let mut energy: f32 = energies.iter().sum();
    for (a, b) in a_rest.iter().zip(b_rest) {
        product += a * b;
        energy += b * b;
    }
    (product, energy)
}

fn mixdown(channels: &[&[f32]]) -> Vec<f32> {
    let scale = 1.0 / channels.len() as f32;
    (0..channels[0].len())
        .map(|i| channels.iter().map(|channel| channel[i]).sum::<f32>() * scale)
        .collect()
}

/// A sample, or silence outside the input.
fn sample(channel: &[f32], index: isize) -> f32 {
    if index < 0 {
        return 0.0;
    }
    channel.get(index as usize).copied().unwrap_or(0.0)
}

fn even(value: usize) -> usize {
    value & !1
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: u32 = 48_000;

    fn sine(frequency: f32, seconds: f32) -> Vec<f32> {
        (0..(RATE as f32 * seconds) as usize)
            .map(|i| (2.0 * PI * frequency * i as f32 / RATE as f32).sin() * 0.5)
            .collect()
    }

    /// The frequency, from the rising zero crossings away from the edges.
    fn frequency(samples: &[f32]) -> f32 {
        let inner = &samples[samples.len() / 10..samples.len() * 9 / 10];
        let crossings = inner
            .windows(2)
            .filter(|pair| pair[0] < 0.0 && pair[1] >= 0.0)
            .count();
        crossings as f32 * RATE as f32 / inner.len() as f32
    }

    fn rms(samples: &[f32]) -> f32 {
        (samples.iter().map(|value| value * value).sum::<f32>() / samples.len() as f32).sqrt()
    }

    fn stretch(channels: &[&[f32]], tempo: f64, output_length: usize) -> Vec<Vec<f32>> {
        time_stretch(TimeStretchOptions {
            channels,
            sample_rate: RATE,
            tempo,
            output_length,
        })
    }

    #[test]
    fn keeps_the_pitch_and_takes_the_length_asked() {
        let input = sine(440.0, 2.0);
        for tempo in [0.5, 0.75, 1.5, 2.0] {
            let length = (input.len() as f64 / tempo) as usize;
            let output = &stretch(&[&input], tempo, length)[0];
            assert_eq!(output.len(), length);
            let found = frequency(output);
            assert!((found - 440.0).abs() < 5.0, "tempo {tempo}: {found} Hz");
            // A cross-fade of out-of-phase windows would dip the level.
            let level = rms(&output[length / 10..length * 9 / 10]);
            assert!(
                (level - rms(&input)).abs() < 0.02,
                "tempo {tempo}: rms {level}"
            );
        }
    }

    #[test]
    fn a_tempo_of_one_copies() {
        let input = sine(220.0, 0.5);
        let output = &stretch(&[&input], 1.0, input.len())[0];
        assert_eq!(output, &input);
    }

    #[test]
    fn starts_at_full_level() {
        let input = vec![0.25; RATE as usize];
        let output = &stretch(&[&input], 1.5, 20_000)[0];
        assert!(
            output[1..2_000]
                .iter()
                .all(|value| (value - 0.25).abs() < 1e-3)
        );
    }

    #[test]
    fn past_the_input_is_silence() {
        let input = sine(440.0, 0.5);
        let output = &stretch(&[&input], 2.0, input.len())[0];
        let tail = &output[input.len() / 2 + 2_000..];
        assert!(tail.iter().all(|value| value.abs() < 1e-6));
    }

    #[test]
    fn channels_stay_together() {
        let left = sine(440.0, 1.0);
        let right: Vec<f32> = left.iter().map(|value| -value).collect();
        let output = stretch(&[&left, &right], 1.3, 30_000);
        for (l, r) in output[0].iter().zip(&output[1]) {
            assert!((l + r).abs() < 1e-5);
        }
    }

    #[test]
    fn nothing_in_nothing_out() {
        assert_eq!(stretch(&[&[]], 1.5, 10), vec![vec![0.0; 10]]);
        assert_eq!(stretch(&[], 1.5, 3), vec![vec![0.0; 3]]);
    }
}

#[cfg(test)]
mod speed {
    use super::*;

    #[test]
    #[ignore = "a benchmark: cargo test -p audio --release -- --ignored --nocapture"]
    fn a_minute_of_stereo() {
        let length = 48_000 * 60;
        let left: Vec<f32> = (0..length)
            .map(|i| ((i as f32) * 0.0577).sin() * 0.3)
            .collect();
        let right: Vec<f32> = (0..length)
            .map(|i| ((i as f32) * 0.0311).sin() * 0.3)
            .collect();
        let started = std::time::Instant::now();
        time_stretch(TimeStretchOptions {
            channels: &[&left, &right],
            sample_rate: 48_000,
            tempo: 1.25,
            output_length: (length as f64 / 1.25) as usize,
        });
        println!("a minute of stereo at 1.25x: {:?}", started.elapsed());
    }
}
