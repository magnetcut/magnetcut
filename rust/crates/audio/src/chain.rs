//! A clip's sound through its processors, always in the same order: noise,
//! hum, low cut, equaliser, compressor, echo, reverb. The chain keeps its
//! state from one block to the next, so the preview can stream through it and
//! the export can run a clip a window at a time, with the same result as all
//! at once.

use crate::biquad::{BUTTERWORTH_4, Coefficients, Design, FilterBank};
use crate::compressor::Compressor;
use crate::denoise::Denoise;
use crate::echo::Echo;
use crate::reverb::Reverb;
use crate::settings::{AudioEffectSettings, EqBand};

/// Hum's harmonics are taken out up to this one.
const HUM_HARMONICS: u32 = 5;
/// The notches' width: at 50 Hz, about 1.7 Hz.
const HUM_Q: f64 = 30.0;
/// The highest frequency a notch is put at, as a share of the sample rate.
const HUM_HIGHEST: f64 = 0.45;

enum Stage {
    Denoise(Denoise),
    Filters(FilterBank),
    Compressor(Compressor),
    Echo(Echo),
    Reverb(Reverb),
}

impl Stage {
    fn process(&mut self, channels: &mut [Vec<f32>]) {
        match self {
            Stage::Denoise(stage) => stage.process(channels),
            Stage::Filters(stage) => stage.process(channels),
            Stage::Compressor(stage) => stage.process(channels),
            Stage::Echo(stage) => stage.process(channels),
            Stage::Reverb(stage) => stage.process(channels),
        }
    }
}

/// The processors a clip's settings turn on, with their state.
pub struct AudioEffectsChain {
    channels: usize,
    latency: usize,
    stages: Vec<Stage>,
}

impl AudioEffectsChain {
    /// The processors that are off aren't made: they cost nothing.
    pub fn new(settings: &AudioEffectSettings, sample_rate: u32, channels: usize) -> Self {
        let sample_rate = sample_rate.max(1);
        let rate = f64::from(sample_rate);
        let mut stages = Vec::new();
        let mut latency = 0;

        let strength = settings.noise_strength();
        if strength > 0.0 {
            let denoise = Denoise::new(strength, sample_rate, channels);
            latency = denoise.latency();
            stages.push(Stage::Denoise(denoise));
        }

        // Hum, low cut and the equaliser are all biquads: one cascade.
        let mut filters = Vec::new();
        if let Some(hum) = settings.hum() {
            let hum = f64::from(hum);
            filters.extend(
                (1..=HUM_HARMONICS)
                    .map(|harmonic| hum * f64::from(harmonic))
                    .take_while(|&frequency| frequency < rate * HUM_HIGHEST)
                    .map(|frequency| {
                        Coefficients::new(
                            Design::Notch {
                                frequency,
                                q: HUM_Q,
                            },
                            rate,
                        )
                    }),
            );
        }
        if let Some(frequency) = settings.low_cut_frequency() {
            let frequency = f64::from(frequency);
            filters.extend(
                BUTTERWORTH_4
                    .iter()
                    .map(|&q| Coefficients::new(Design::HighPass { frequency, q }, rate)),
            );
        }
        filters.extend(settings.eq_bands().into_iter().map(|band| {
            let design = match band {
                EqBand::LowShelf { gain, frequency } => Design::LowShelf {
                    frequency: f64::from(frequency),
                    gain: f64::from(gain),
                },
                EqBand::Peak { gain, frequency, q } => Design::Peak {
                    frequency: f64::from(frequency),
                    q: f64::from(q),
                    gain: f64::from(gain),
                },
                EqBand::HighShelf { gain, frequency } => Design::HighShelf {
                    frequency: f64::from(frequency),
                    gain: f64::from(gain),
                },
            };
            Coefficients::new(design, rate)
        }));
        if !filters.is_empty() {
            stages.push(Stage::Filters(FilterBank::new(filters, channels)));
        }

        let rate = sample_rate as f32;
        if let Some(compressor) = settings.compressor() {
            stages.push(Stage::Compressor(Compressor::new(compressor, rate)));
        }
        if let Some(echo) = settings.echo() {
            stages.push(Stage::Echo(Echo::new(echo, rate, channels)));
        }
        if let Some(reverb) = settings.reverb() {
            stages.push(Stage::Reverb(Reverb::new(reverb, rate, channels)));
        }

        AudioEffectsChain {
            channels,
            latency,
            stages,
        }
    }

    /// How many samples late the output is: what comes out of `process` is
    /// what went in this many samples earlier. Only the noise reduction
    /// delays the sound.
    pub fn latency(&self) -> usize {
        self.latency
    }

    /// Whether the chain changes nothing (every processor off).
    pub fn is_identity(&self) -> bool {
        self.stages.is_empty()
    }

    /// The next block, one slice per channel, all the same length; as many
    /// samples come out, `latency()` late. Blocks may be any size.
    ///
    /// # Panics
    /// If there aren't as many slices as the chain's channels, or they differ
    /// in length.
    pub fn process(&mut self, input: &[&[f32]]) -> Vec<Vec<f32>> {
        assert_eq!(input.len(), self.channels, "one slice per channel");
        let length = input.first().map_or(0, |channel| channel.len());
        assert!(
            input.iter().all(|channel| channel.len() == length),
            "the channels' lengths differ"
        );
        let mut channels: Vec<Vec<f32>> = input.iter().map(|channel| channel.to_vec()).collect();
        if length > 0 {
            for stage in &mut self.stages {
                stage.process(&mut channels);
            }
        }
        channels
    }
}

pub struct ApplyAudioEffectsOptions<'a> {
    /// One slice per channel, all the same length.
    pub channels: &'a [&'a [f32]],
    pub sample_rate: u32,
    pub settings: &'a AudioEffectSettings,
}

/// A whole clip's sound through its processors. As long as the input, and
/// lined up with it: the chain's latency is made up. The echo and the reverb
/// stop at the clip's end, as its sound does.
pub fn apply_audio_effects(
    ApplyAudioEffectsOptions {
        channels,
        sample_rate,
        settings,
    }: ApplyAudioEffectsOptions,
) -> Vec<Vec<f32>> {
    let mut chain = AudioEffectsChain::new(settings, sample_rate, channels.len());
    let mut output = chain.process(channels);
    let latency = chain.latency();
    if latency > 0 {
        let length = channels.first().map_or(0, |channel| channel.len());
        let silence = vec![0.0f32; latency];
        let silences = vec![silence.as_slice(); channels.len()];
        let rest = chain.process(&silences);
        for (channel, rest) in output.iter_mut().zip(rest) {
            channel.extend(rest);
            channel.drain(..latency);
            channel.truncate(length);
        }
    }
    output
}
