//! The chain and the loudness meter on made-up signals.

use std::f64::consts::PI;

use crate::denoise::Denoise;
use crate::{
    ApplyAudioEffectsOptions, AudioEffectSettings, AudioEffectsChain, LoudnessMeter,
    apply_audio_effects,
};

/// A small xorshift generator, so the tests don't need a crate for noise.
struct Random(u64);

impl Random {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    /// From -1 to 1.
    fn sample(&mut self) -> f32 {
        (self.next() >> 40) as f32 / (1u64 << 23) as f32 - 1.0
    }

    fn below(&mut self, limit: usize) -> usize {
        (self.next() % limit as u64) as usize
    }
}

fn sine(frequency: f64, rate: u32, seconds: f64, amplitude: f32) -> Vec<f32> {
    let length = (f64::from(rate) * seconds) as usize;
    (0..length)
        .map(|n| (2.0 * PI * frequency * n as f64 / f64::from(rate)).sin() as f32 * amplitude)
        .collect()
}

fn noise(rate: u32, seconds: f64, amplitude: f32, seed: u64) -> Vec<f32> {
    let mut random = Random(seed);
    let length = (f64::from(rate) * seconds) as usize;
    (0..length).map(|_| random.sample() * amplitude).collect()
}

fn rms(samples: &[f32]) -> f64 {
    (samples
        .iter()
        .map(|&value| f64::from(value).powi(2))
        .sum::<f64>()
        / samples.len() as f64)
        .sqrt()
}

fn peak(samples: &[f32]) -> f32 {
    samples
        .iter()
        .fold(0.0, |peak, value| peak.max(value.abs()))
}

fn db(ratio: f64) -> f64 {
    20.0 * ratio.log10()
}

/// The output's level beside the input's, dB, over the second half (past
/// the filters' settling).
fn gain_db(settings: &AudioEffectSettings, input: &[f32], rate: u32) -> f64 {
    let output = apply(settings, &[input], rate);
    let half = input.len() / 2;
    db(rms(&output[0][half..]) / rms(&input[half..]))
}

fn apply(settings: &AudioEffectSettings, channels: &[&[f32]], rate: u32) -> Vec<Vec<f32>> {
    apply_audio_effects(ApplyAudioEffectsOptions {
        channels,
        sample_rate: rate,
        settings,
    })
}

/// The chain over a sound in blocks of random sizes, 1 sample among them.
fn streamed(
    settings: &AudioEffectSettings,
    channels: &[&[f32]],
    rate: u32,
    seed: u64,
) -> Vec<Vec<f32>> {
    let mut chain = AudioEffectsChain::new(settings, rate, channels.len());
    let mut random = Random(seed);
    let length = channels[0].len();
    let mut output = vec![Vec::with_capacity(length); channels.len()];
    let mut at = 0;
    while at < length {
        let size = match random.below(4) {
            0 => 1,
            1 => 1 + random.below(16),
            2 => 128,
            _ => 1 + random.below(5000),
        };
        let end = (at + size).min(length);
        let block: Vec<&[f32]> = channels.iter().map(|channel| &channel[at..end]).collect();
        for (out, processed) in output.iter_mut().zip(chain.process(&block)) {
            out.extend(processed);
        }
        at = end;
    }
    output
}

fn everything_on() -> AudioEffectSettings {
    AudioEffectSettings {
        noise_reduction: 0.7,
        hum_frequency: 50.0,
        low_cut: 80.0,
        eq_enabled: true,
        eq_low_gain: -2.0,
        eq_mid1_gain: 3.0,
        eq_mid2_gain: -4.0,
        eq_mid3_gain: 2.0,
        eq_high_gain: 1.5,
        compressor_enabled: true,
        echo_enabled: true,
        echo_delay: 120.0,
        reverb_enabled: true,
        ..Default::default()
    }
}

#[test]
fn all_off_returns_the_input() {
    let left = noise(44_100, 0.5, 0.5, 1);
    let right = noise(44_100, 0.5, 0.5, 2);
    let settings = AudioEffectSettings::default();
    assert_eq!(
        apply(&settings, &[&left, &right], 44_100),
        vec![left.clone(), right.clone()]
    );
    let mut chain = AudioEffectsChain::new(&settings, 44_100, 2);
    assert!(chain.is_identity());
    assert_eq!(chain.latency(), 0);
    assert_eq!(chain.process(&[&left, &right]), vec![left, right]);
}

#[test]
fn the_low_cut_takes_out_whats_below() {
    let settings = AudioEffectSettings {
        low_cut: 100.0,
        ..Default::default()
    };
    for rate in [44_100, 48_000] {
        let below = gain_db(&settings, &sine(25.0, rate, 2.0, 0.5), rate);
        assert!(below < -20.0, "{rate}: 25 Hz {below} dB");
        // A 4th-order Butterworth is 3 dB down at its cutoff, 0.1 by 250 Hz.
        for frequency in [300.0, 1000.0, 10_000.0] {
            let above = gain_db(&settings, &sine(frequency, rate, 1.0, 0.5), rate);
            assert!(above.abs() < 1.0, "{rate}: {frequency} Hz {above} dB");
        }
        let at = gain_db(&settings, &sine(100.0, rate, 2.0, 0.5), rate);
        assert!((at + 3.0).abs() < 0.2, "{rate}: 100 Hz {at} dB");
    }
}

#[test]
fn an_equaliser_peak_has_its_gain_at_its_centre() {
    for (gain, frequency, q) in [(6.0, 1500.0, 1.0), (-9.0, 400.0, 2.0), (12.0, 4000.0, 0.7)] {
        let settings = AudioEffectSettings {
            eq_enabled: true,
            eq_mid2_gain: gain,
            eq_mid2_frequency: frequency,
            eq_mid2_q: q,
            ..Default::default()
        };
        let measured = gain_db(
            &settings,
            &sine(f64::from(frequency), 48_000, 1.0, 0.2),
            48_000,
        );
        assert!(
            (measured - f64::from(gain)).abs() < 0.5,
            "{gain} dB at {frequency} Hz: {measured}"
        );
        // Far from it, nothing.
        let far = gain_db(
            &settings,
            &sine(f64::from(frequency) / 30.0, 48_000, 2.0, 0.2),
            48_000,
        );
        assert!(far.abs() < 0.5, "{far}");
    }
}

#[test]
fn the_shelves_lift_their_ends() {
    let settings = AudioEffectSettings {
        eq_enabled: true,
        eq_low_gain: 6.0,
        eq_high_gain: -6.0,
        ..Default::default()
    };
    let low = gain_db(&settings, &sine(20.0, 48_000, 2.0, 0.2), 48_000);
    let middle = gain_db(&settings, &sine(1000.0, 48_000, 1.0, 0.2), 48_000);
    let high = gain_db(&settings, &sine(20_000.0, 48_000, 1.0, 0.2), 48_000);
    assert!((low - 6.0).abs() < 0.5, "{low}");
    assert!(middle.abs() < 0.5, "{middle}");
    assert!((high + 6.0).abs() < 1.0, "{high}");
}

#[test]
fn hum_is_taken_out_and_the_rest_kept() {
    for (hum, rate) in [(50.0, 48_000), (60.0, 44_100)] {
        let settings = AudioEffectSettings {
            hum_frequency: hum,
            ..Default::default()
        };
        for harmonic in [1.0, 2.0, 3.0, 5.0] {
            let frequency = f64::from(hum) * harmonic;
            let removed = gain_db(&settings, &sine(frequency, rate, 4.0, 0.5), rate);
            assert!(removed < -30.0, "{frequency} Hz: {removed} dB");
        }
        for frequency in [1000.0, 440.0, 3000.0] {
            let kept = gain_db(&settings, &sine(frequency, rate, 2.0, 0.5), rate);
            assert!(kept.abs() < 1.0, "{frequency} Hz: {kept} dB");
        }
    }
}

#[test]
fn the_compressor_follows_its_ratio() {
    for (threshold, ratio, level, makeup) in [
        (-20.0, 4.0, 0.0, 0.0),
        (-30.0, 2.0, -6.0, 3.0),
        (-12.0, 8.0, -2.0, 0.0),
    ] {
        let settings = AudioEffectSettings {
            compressor_enabled: true,
            compressor_threshold: threshold,
            compressor_ratio: ratio,
            compressor_attack: 5.0,
            compressor_release: 200.0,
            compressor_makeup: makeup,
            ..Default::default()
        };
        let amplitude = 10f32.powf(level / 20.0);
        let input = sine(1000.0, 48_000, 2.0, amplitude);
        let output = apply(&settings, &[&input], 48_000);
        let steady = &output[0][input.len() / 2..];
        let measured = f64::from(20.0 * peak(steady).log10());
        let expected = f64::from(threshold + (level - threshold) / ratio + makeup);
        assert!(
            (measured - expected).abs() < 0.75,
            "{threshold} dB, {ratio}:1, in at {level} dB: {measured}, not {expected}"
        );
    }
    // Below the threshold and its knee, it's left alone.
    let settings = AudioEffectSettings {
        compressor_enabled: true,
        compressor_threshold: -10.0,
        ..Default::default()
    };
    let quiet = sine(1000.0, 48_000, 1.0, 0.05);
    assert_eq!(apply(&settings, &[&quiet], 48_000)[0], quiet);
}

#[test]
fn the_compressor_turns_both_channels_down_together() {
    let settings = AudioEffectSettings {
        compressor_enabled: true,
        ..Default::default()
    };
    let loud = sine(500.0, 48_000, 1.0, 0.9);
    let quiet: Vec<f32> = loud.iter().map(|value| value * 0.1).collect();
    let output = apply(&settings, &[&loud, &quiet], 48_000);
    for ((l, q), (out_l, out_q)) in loud
        .iter()
        .zip(&quiet)
        .zip(output[0].iter().zip(&output[1]))
    {
        if l.abs() > 0.01 {
            assert!((out_l / l - out_q / q).abs() < 1e-4);
        }
    }
}

#[test]
fn an_echo_comes_at_its_delay() {
    let settings = AudioEffectSettings {
        echo_enabled: true,
        echo_delay: 250.0,
        echo_feedback: 0.6,
        echo_mix: 0.5,
        ..Default::default()
    };
    let rate = 44_100;
    let delay = 11_025;
    let mut impulse = vec![0.0f32; rate as usize * 2];
    impulse[0] = 1.0;
    let output = &apply(&settings, &[&impulse], rate)[0];
    assert!((output[0] - 0.5).abs() < 1e-6);
    assert!((output[delay] - 0.5).abs() < 1e-6);
    assert!((output[2 * delay] - 0.5 * 0.6).abs() < 1e-6);
    assert!((output[3 * delay] - 0.5 * 0.36).abs() < 1e-6);
    assert!(output[1..delay].iter().all(|value| *value == 0.0));
}

#[test]
fn reverb_rings_and_dies_away() {
    let settings = AudioEffectSettings {
        reverb_enabled: true,
        reverb_room_size: 0.7,
        reverb_mix: 0.5,
        ..Default::default()
    };
    let rate = 48_000;
    let mut input = vec![vec![0.0f32; rate as usize * 5]; 2];
    // A short burst of noise on the left, then silence.
    for (n, value) in noise(rate, 0.05, 0.8, 3).into_iter().enumerate() {
        input[0][n] = value;
    }
    let slices: Vec<&[f32]> = input.iter().map(Vec::as_slice).collect();
    let output = apply(&settings, &slices, rate);
    for channel in &output {
        assert!(channel.iter().all(|value| value.is_finite()));
        let levels: Vec<f64> = channel[rate as usize / 10..]
            .chunks(rate as usize / 2)
            .map(rms)
            .collect();
        assert!(levels[0] > 1e-3, "{levels:?}");
        assert!(
            levels.windows(2).all(|pair| pair[1] < pair[0]),
            "{levels:?}"
        );
        assert!(levels[levels.len() - 1] < levels[0] / 100.0, "{levels:?}");
    }
}

#[test]
fn streaming_in_blocks_matches_the_whole() {
    let rate = 44_100;
    let left: Vec<f32> = sine(220.0, rate, 1.5, 0.4)
        .iter()
        .zip(noise(rate, 1.5, 0.1, 4))
        .map(|(a, b)| a + b)
        .collect();
    let right = noise(rate, 1.5, 0.3, 5);
    let settings = everything_on();
    let mut chain = AudioEffectsChain::new(&settings, rate, 2);
    let whole = chain.process(&[&left, &right]);
    for seed in [6, 7] {
        let pieces = streamed(&settings, &[&left, &right], rate, seed);
        for (a, b) in whole.iter().zip(&pieces) {
            assert_eq!(a.len(), b.len());
            let worst = a
                .iter()
                .zip(b)
                .map(|(a, b)| (a - b).abs())
                .fold(0.0, f32::max);
            assert!(worst < 1e-5, "{worst}");
        }
    }
    // And the whole clip, lined up: the chain's output without its latency.
    let latency = chain.latency();
    assert!(latency > 0);
    let applied = apply(&settings, &[&left, &right], rate);
    for (a, b) in applied.iter().zip(&whole) {
        assert_eq!(a.len(), left.len());
        assert_eq!(&a[..left.len() - latency], &b[latency..]);
    }
}

#[test]
fn a_mono_clip_and_many_channels_work() {
    let settings = everything_on();
    let mono = noise(48_000, 1.0, 0.3, 8);
    let output = apply(&settings, &[&mono], 48_000);
    assert_eq!(output.len(), 1);
    assert!(output[0].iter().all(|value| value.is_finite()));
    let channels: Vec<Vec<f32>> = (0..6)
        .map(|seed| noise(48_000, 0.5, 0.3, 10 + seed))
        .collect();
    let slices: Vec<&[f32]> = channels.iter().map(Vec::as_slice).collect();
    let output = apply(&settings, &slices, 48_000);
    assert_eq!(output.len(), 6);
    assert!(output.iter().all(|channel| channel.len() == 24_000));
}

/// The noise reduction's timing, with the network left out: what comes out is
/// what went in, `latency()` samples later, through the resampling and back.
#[test]
fn noise_reduction_is_latency_late_at_any_rate() {
    for rate in [
        8_000, 11_025, 16_000, 22_050, 32_000, 37_800, 44_100, 48_000, 88_200, 96_000, 192_000,
    ] {
        let mut denoise = Denoise::new(1.0, rate, 1);
        denoise.skip_network();
        let latency = denoise.latency();
        // Two tones well inside the band that survives resampling.
        let length = rate as usize / 2;
        let input: Vec<f32> = (0..length)
            .map(|n| {
                let t = n as f64 / f64::from(rate);
                ((2.0 * PI * 0.05 * f64::from(rate) * t).sin() * 0.3
                    + (2.0 * PI * 0.13 * f64::from(rate.min(48_000)) * t).sin() * 0.2)
                    as f32
            })
            .collect();
        // One sample at a time: the queue must never run dry (a debug
        // assertion), and nothing may depend on the block size.
        let mut output = Vec::with_capacity(length);
        for &sample in &input {
            let mut block = vec![vec![sample]];
            denoise.process(&mut block);
            output.push(block[0][0]);
        }
        let settle = latency + rate as usize / 50;
        let worst = output[settle..]
            .iter()
            .zip(&input[settle - latency..])
            .map(|(a, b)| (a - b).abs())
            .fold(0.0, f32::max);
        assert!(worst < 2e-3, "{rate}: off by {worst}, latency {latency}");
    }
}

#[test]
fn noise_reductions_latency() {
    let latency = |rate| AudioEffectsChain::new(&everything_on(), rate, 2).latency();
    assert_eq!(latency(48_000), 959);
    assert_eq!(latency(44_100), 945);
}

/// Steady noise like a fan's or air's: white noise through a low-pass.
fn rumble(rate: u32, seconds: f64, seed: u64) -> Vec<f32> {
    let mut state = 0.0f32;
    noise(rate, seconds, 0.03, seed)
        .into_iter()
        .map(|value| {
            state = 0.97 * state + 0.03 * value;
            state * 8.0
        })
        .collect()
}

#[test]
fn noise_reduction_takes_out_steady_noise() {
    for rate in [48_000, 44_100] {
        let settings = AudioEffectSettings {
            noise_reduction: 1.0,
            ..Default::default()
        };
        let input = rumble(rate, 3.0, 9);
        let output = apply(&settings, &[&input], rate);
        assert!(output[0].iter().all(|value| value.is_finite()));
        // Past the first second, once the network has heard the noise.
        let from = rate as usize;
        let reduction = db(rms(&output[0][from..]) / rms(&input[from..]));
        assert!(reduction < -20.0, "{rate}: {reduction} dB");

        // At half strength, half the original is mixed back in.
        let half = AudioEffectSettings {
            noise_reduction: 0.5,
            ..Default::default()
        };
        let output = apply(&half, &[&input], rate);
        let reduction = db(rms(&output[0][from..]) / rms(&input[from..]));
        assert!(
            (-7.0..-5.0).contains(&reduction),
            "{rate}: half {reduction} dB"
        );
    }
}

/// RNNoise's model handles white noise unevenly, from level to level; what
/// comes out is never louder, and never anything but numbers.
#[test]
fn noise_reduction_keeps_white_noise_finite() {
    for rate in [48_000, 44_100] {
        let settings = AudioEffectSettings {
            noise_reduction: 1.0,
            ..Default::default()
        };
        for amplitude in [0.001, 0.01, 0.1, 1.0] {
            let input = noise(rate, 1.0, amplitude, 12);
            let output = apply(&settings, &[&input], rate);
            assert!(output[0].iter().all(|value| value.is_finite()));
            let from = rate as usize / 2;
            let change = db(rms(&output[0][from..]) / rms(&input[from..]));
            assert!(change < 0.0, "{rate}, {amplitude}: {change} dB");
        }
    }
}

/// With the network in, what's left of the input is still where it was: the
/// output correlates with the input best at no lag. (Broadband: RNNoise's own
/// high-pass at 15 Hz would shift a low tone's phase.)
#[test]
fn noise_reduction_stays_lined_up() {
    for rate in [48_000, 44_100] {
        let settings = AudioEffectSettings {
            noise_reduction: 1.0,
            ..Default::default()
        };
        let input = noise(rate, 1.0, 0.1, 11);
        let output = &apply(&settings, &[&input], rate)[0];
        let start = rate as usize / 2;
        let window = &input[start..start + rate as usize / 4];
        let correlation = |lag: isize| -> f64 {
            window
                .iter()
                .enumerate()
                .map(|(n, &value)| {
                    let at = (start + n) as isize + lag;
                    f64::from(value) * f64::from(output[at as usize])
                })
                .sum()
        };
        let best = (-600..=600)
            .max_by(|&a, &b| correlation(a).total_cmp(&correlation(b)))
            .unwrap();
        assert_eq!(best, 0, "{rate}");
    }
}

#[test]
#[ignore = "a benchmark: cargo test -p audio --release -- --ignored --nocapture"]
fn a_minute_of_stereo_through_the_chain() {
    for rate in [48_000, 44_100] {
        let left = noise(rate, 60.0, 0.3, 13);
        let right = noise(rate, 60.0, 0.3, 14);
        let noise_only = AudioEffectSettings {
            noise_reduction: 1.0,
            ..Default::default()
        };
        let the_rest = AudioEffectSettings {
            noise_reduction: 0.0,
            ..everything_on()
        };
        for (name, settings) in [("noise reduction", noise_only), ("the rest", the_rest)] {
            let started = std::time::Instant::now();
            apply(&settings, &[&left, &right], rate);
            let elapsed = started.elapsed().as_secs_f64();
            println!(
                "{rate} Hz, {name}: a minute of stereo in {elapsed:.3} s, {:.0}x real time",
                60.0 / elapsed
            );
        }
    }
}

/// dBFS as an amplitude.
fn amplitude(db: f64) -> f32 {
    10f64.powf(db / 20.0) as f32
}

fn measure(channels: &[&[f32]], rate: u32) -> LoudnessMeter {
    let mut meter = LoudnessMeter::new(rate, channels.len());
    meter.push(channels);
    meter
}

/// EBU Tech 3341's first two cases: a 1 kHz sine at -23 or -33 dBFS in both
/// channels reads -23 or -33 LUFS. At 0 dBFS in one channel it reads -3.01
/// LUFS, so in two, 0.
#[test]
fn a_stereo_sine_reads_its_level_at_any_rate() {
    for (rate, level) in [
        (44_100, -23.0),
        (48_000, -23.0),
        (96_000, -23.0),
        (48_000, -20.0),
        (48_000, -33.0),
    ] {
        let tone = sine(1000.0, rate, 1.0, amplitude(level));
        let lufs = measure(&[&tone, &tone], rate).integrated().unwrap();
        assert!(
            (lufs - level).abs() < 0.1,
            "{rate} Hz, {level} dBFS: {lufs}"
        );
    }
}

/// One channel has half the power of two: 3.01 LU less.
#[test]
fn a_mono_sine_reads_3_lu_under_stereo() {
    let rate = 48_000;
    let tone = sine(1000.0, rate, 1.0, amplitude(-20.0));
    let lufs = measure(&[&tone], rate).integrated().unwrap();
    assert!((lufs + 23.01).abs() < 0.1, "{lufs}");
}

/// In 5.1 the LFE isn't counted and the surrounds count 1.41 times.
#[test]
fn surround_channels_are_weighted() {
    let rate = 48_000;
    let tone = sine(1000.0, rate, 1.0, amplitude(-20.0));
    let silence = vec![0.0; tone.len()];
    let only = |channel: usize| {
        let channels: Vec<&[f32]> = (0..6)
            .map(|c| if c == channel { &tone } else { &silence }.as_slice())
            .collect();
        measure(&channels, rate).integrated()
    };
    let front = only(0).unwrap();
    assert!((only(2).unwrap() - front).abs() < 1e-9);
    assert_eq!(only(3), None);
    assert!((only(4).unwrap() - front - 10.0 * 1.41f64.log10()).abs() < 1e-9);
}

/// A loud second, then 10 s of hiss at about -60 LUFS: over the absolute gate
/// but under the relative one, which the mean of every block puts at about
/// -44. What's left is the loud second's seven blocks and the three that
/// overlap its end by 3/4, 1/2 and 1/4: -23 + 10 log10(8.5 / 10).
#[test]
fn quiet_blocks_are_gated_out() {
    let rate = 48_000;
    let hiss_left = noise(rate, 10.0, 0.001, 20);
    let hiss_right = noise(rate, 10.0, 0.001, 21);
    let quiet = measure(
        &[&hiss_left[..rate as usize], &hiss_right[..rate as usize]],
        rate,
    )
    .integrated()
    .unwrap();
    assert!((-65.0..-55.0).contains(&quiet), "{quiet}");
    let tone = sine(1000.0, rate, 1.0, amplitude(-23.0));
    let left: Vec<f32> = tone.iter().chain(&hiss_left).copied().collect();
    let right: Vec<f32> = tone.iter().chain(&hiss_right).copied().collect();
    let lufs = measure(&[&left, &right], rate).integrated().unwrap();
    let expected = -23.0 + 10.0 * 0.85f64.log10();
    assert!((lufs - expected).abs() < 0.05, "{lufs} {expected}");
}

#[test]
fn silence_has_no_loudness() {
    let rate = 48_000;
    let meter = LoudnessMeter::new(rate, 2);
    assert_eq!(meter.integrated(), None);
    assert_eq!(meter.true_peak(), f64::NEG_INFINITY);
    let silence = vec![0.0; 4 * 48_000];
    let meter = measure(&[&silence, &silence], rate);
    assert_eq!(meter.integrated(), None);
    assert_eq!(meter.loudness_range(), None);
    assert_eq!(meter.true_peak(), f64::NEG_INFINITY);
    // Under -70 LUFS, and shorter than a block.
    let hiss = noise(rate, 2.0, 0.000_05, 22);
    assert_eq!(measure(&[&hiss], rate).integrated(), None);
    let short = sine(1000.0, rate, 0.39, 0.5);
    assert_eq!(measure(&[&short], rate).integrated(), None);
}

/// Blocks of odd sizes, 1 sample and none among them, give exactly what one
/// push does.
#[test]
fn pushing_in_blocks_matches_the_whole() {
    let rate = 44_100;
    let seconds = 4.0;
    // Louder and louder, for a loudness range.
    let swell = |n: usize| (n as f32 / (seconds as f32 * rate as f32)).powi(2);
    let left: Vec<f32> = sine(440.0, rate, seconds, 0.3)
        .iter()
        .zip(noise(rate, seconds, 0.2, 23))
        .enumerate()
        .map(|(n, (a, b))| (a + b) * swell(n))
        .collect();
    let right: Vec<f32> = noise(rate, seconds, 0.6, 24)
        .iter()
        .enumerate()
        .map(|(n, value)| value * swell(n))
        .collect();
    let whole = measure(&[&left, &right], rate);
    assert!(whole.loudness_range().unwrap() > 3.0);
    for seed in [25, 26] {
        let mut random = Random(seed);
        let mut meter = LoudnessMeter::new(rate, 2);
        let mut at = 0;
        while at < left.len() {
            let size = match random.below(4) {
                0 => 1,
                1 => random.below(16),
                2 => 4410,
                _ => 1 + random.below(10_000),
            };
            let end = (at + size).min(left.len());
            meter.push(&[&left[at..end], &right[at..end]]);
            at = end;
        }
        assert_eq!(meter.integrated(), whole.integrated());
        assert_eq!(meter.true_peak(), whole.true_peak());
        assert_eq!(meter.loudness_range(), whole.loudness_range());
    }
}

#[test]
fn a_full_scale_sine_peaks_at_0_dbtp() {
    for rate in [44_100, 48_000, 96_000] {
        let tone = sine(1000.0, rate, 0.5, 1.0);
        let peak = measure(&[&tone, &tone], rate).true_peak();
        assert!(peak.abs() < 0.1, "{rate} Hz: {peak}");
    }
}

/// A sine at a quarter of the sample rate, 45 degrees in: every sample is
/// ±0.707 (-3.01 dBFS), the peaks halfway between. Four times oversampled,
/// the nearest points are an eighth of a sample from them (-0.17 dB), where
/// the standard's filter has 0.22 dB of gain: about 0 dBTP.
#[test]
fn the_true_peak_finds_whats_between_samples() {
    let rate = 48_000;
    let signal: Vec<f32> = (0..4800)
        .map(|n| (PI / 2.0 * n as f64 + PI / 4.0).sin() as f32)
        .collect();
    let sample_peak = db(f64::from(peak(&signal)));
    assert!((sample_peak + 3.01).abs() < 0.01);
    let true_peak = measure(&[&signal], rate).true_peak();
    assert!((-0.2..0.2).contains(&true_peak), "{true_peak}");
    // And between the last two samples, after which nothing is pushed.
    let mut end = vec![0.0; 100];
    end.extend([0.5, 0.5]);
    let true_peak = measure(&[&end], rate).true_peak();
    assert!(true_peak > db(0.5) + 1.0, "{true_peak}");
}

/// EBU Tech 3342's first two cases, shortened: a 1 kHz sine at -20 dBFS,
/// then at -30 (or -15), is a range of 10 LU (or 5), ±1.
#[test]
fn the_loudness_range_spans_the_levels() {
    let rate = 48_000;
    for (first, second, expected) in [(-20.0, -30.0, 10.0), (-20.0, -15.0, 5.0)] {
        let mut tone = sine(1000.0, rate, 5.0, amplitude(first));
        tone.extend(sine(1000.0, rate, 5.0, amplitude(second)));
        let range = measure(&[&tone], rate).loudness_range().unwrap();
        assert!((range - expected).abs() < 1.0, "{range}");
    }
}

#[test]
#[ignore = "a benchmark: cargo test -p audio --release -- --ignored --nocapture"]
fn a_minute_of_stereo_through_the_meter() {
    for rate in [48_000, 44_100] {
        let left = noise(rate, 60.0, 0.3, 27);
        let right = noise(rate, 60.0, 0.3, 28);
        let started = std::time::Instant::now();
        let mut meter = LoudnessMeter::new(rate, 2);
        for (left, right) in left.chunks(4096).zip(right.chunks(4096)) {
            meter.push(&[left, right]);
        }
        let lufs = meter.integrated().unwrap();
        let elapsed = started.elapsed().as_secs_f64();
        println!(
            "{rate} Hz: a minute of stereo metered in {elapsed:.3} s, {:.0}x real time ({lufs:.2} LUFS)",
            60.0 / elapsed
        );
    }
}
