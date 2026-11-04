//! What's done to a clip's sound, as the editor stores it. Every field has a
//! default that leaves the sound alone, so an empty object changes nothing.

use serde::Deserialize;

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AudioEffectSettings {
    /// How much of the noise RNNoise takes out, 0 to 1: 0 is off, 1 the
    /// denoised sound alone, between them the original mixed back in.
    pub noise_reduction: f32,
    /// The mains frequency whose hum is taken out, 50 or 60 Hz; 0 is off.
    pub hum_frequency: f32,
    /// The frequency below which a high-pass takes the sound out, Hz; 0 is off.
    pub low_cut: f32,

    pub eq_enabled: bool,
    /// A low shelf: dB, and the frequency it's centred on.
    pub eq_low_gain: f32,
    pub eq_low_frequency: f32,
    /// Three peaks: dB, centre frequency and width (Q).
    pub eq_mid1_gain: f32,
    pub eq_mid1_frequency: f32,
    pub eq_mid1_q: f32,
    pub eq_mid2_gain: f32,
    pub eq_mid2_frequency: f32,
    pub eq_mid2_q: f32,
    pub eq_mid3_gain: f32,
    pub eq_mid3_frequency: f32,
    pub eq_mid3_q: f32,
    /// A high shelf: dB, and the frequency it's centred on.
    pub eq_high_gain: f32,
    pub eq_high_frequency: f32,

    pub compressor_enabled: bool,
    /// dB below full scale where the compression starts.
    pub compressor_threshold: f32,
    /// How many dB in above the threshold make one dB out.
    pub compressor_ratio: f32,
    /// Milliseconds.
    pub compressor_attack: f32,
    pub compressor_release: f32,
    /// dB added after compressing.
    pub compressor_makeup: f32,

    pub echo_enabled: bool,
    /// Milliseconds between echoes.
    pub echo_delay: f32,
    /// How loud each echo is beside the one before, 0 to 0.95.
    pub echo_feedback: f32,
    /// 0 the original alone, 1 the echoes alone.
    pub echo_mix: f32,

    pub reverb_enabled: bool,
    /// All 0 to 1. Mix: 0 the original alone, 1 the reverb alone.
    pub reverb_room_size: f32,
    pub reverb_damping: f32,
    pub reverb_width: f32,
    pub reverb_mix: f32,
}

impl Default for AudioEffectSettings {
    fn default() -> Self {
        AudioEffectSettings {
            noise_reduction: 0.0,
            hum_frequency: 0.0,
            low_cut: 0.0,
            eq_enabled: false,
            eq_low_gain: 0.0,
            eq_low_frequency: 100.0,
            eq_mid1_gain: 0.0,
            eq_mid1_frequency: 400.0,
            eq_mid1_q: 1.0,
            eq_mid2_gain: 0.0,
            eq_mid2_frequency: 1500.0,
            eq_mid2_q: 1.0,
            eq_mid3_gain: 0.0,
            eq_mid3_frequency: 4000.0,
            eq_mid3_q: 1.0,
            eq_high_gain: 0.0,
            eq_high_frequency: 10_000.0,
            compressor_enabled: false,
            compressor_threshold: -20.0,
            compressor_ratio: 4.0,
            compressor_attack: 10.0,
            compressor_release: 150.0,
            compressor_makeup: 0.0,
            echo_enabled: false,
            echo_delay: 300.0,
            echo_feedback: 0.35,
            echo_mix: 0.3,
            reverb_enabled: false,
            reverb_room_size: 0.5,
            reverb_damping: 0.5,
            reverb_width: 1.0,
            reverb_mix: 0.25,
        }
    }
}

/// A value inside its range; something that isn't a number (a NaN from the
/// editor, say) is taken as the default.
pub(crate) fn clamp(value: f32, low: f32, high: f32, default: f32) -> f32 {
    if value.is_finite() {
        value.clamp(low, high)
    } else {
        default
    }
}

/// Gains closer to 0 dB than this are taken as 0: they'd be inaudible, and
/// the band then costs nothing.
pub(crate) const NEUTRAL_DB: f32 = 0.01;

/// The compressor's settings: dB, a ratio, milliseconds.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Compressor {
    pub threshold: f32,
    pub ratio: f32,
    pub attack: f32,
    pub release: f32,
    pub makeup: f32,
}

/// The echo's settings: milliseconds, then shares.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Echo {
    pub delay: f32,
    pub feedback: f32,
    pub mix: f32,
}

/// The reverb's settings, all 0 to 1.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Reverb {
    pub room_size: f32,
    pub damping: f32,
    pub width: f32,
    pub mix: f32,
}

/// One of the equaliser's bands: gains in dB, frequencies in Hz.
pub(crate) enum EqBand {
    LowShelf { gain: f32, frequency: f32 },
    Peak { gain: f32, frequency: f32, q: f32 },
    HighShelf { gain: f32, frequency: f32 },
}

impl AudioEffectSettings {
    /// The noise reduction's strength, 0 when it's off.
    pub(crate) fn noise_strength(&self) -> f32 {
        clamp(self.noise_reduction, 0.0, 1.0, 0.0)
    }

    /// The hum's fundamental, or None when it's off.
    pub(crate) fn hum(&self) -> Option<f32> {
        let frequency = clamp(self.hum_frequency, 0.0, 1000.0, 0.0);
        (frequency >= 1.0).then_some(frequency)
    }

    /// The low cut's frequency, or None when it's off.
    pub(crate) fn low_cut_frequency(&self) -> Option<f32> {
        let frequency = clamp(self.low_cut, 0.0, 20_000.0, 0.0);
        (frequency >= 1.0).then_some(frequency)
    }

    /// The equaliser's bands whose gain does something.
    pub(crate) fn eq_bands(&self) -> Vec<EqBand> {
        if !self.eq_enabled {
            return Vec::new();
        }
        let defaults = AudioEffectSettings::default();
        let gain = |value: f32| clamp(value, -30.0, 30.0, 0.0);
        let frequency = |value: f32, default: f32| clamp(value, 10.0, 24_000.0, default);
        let q = |value: f32, default: f32| clamp(value, 0.05, 50.0, default);
        let peaks = [
            (
                self.eq_mid1_gain,
                self.eq_mid1_frequency,
                self.eq_mid1_q,
                defaults.eq_mid1_frequency,
            ),
            (
                self.eq_mid2_gain,
                self.eq_mid2_frequency,
                self.eq_mid2_q,
                defaults.eq_mid2_frequency,
            ),
            (
                self.eq_mid3_gain,
                self.eq_mid3_frequency,
                self.eq_mid3_q,
                defaults.eq_mid3_frequency,
            ),
        ];
        let mut bands = vec![EqBand::LowShelf {
            gain: gain(self.eq_low_gain),
            frequency: frequency(self.eq_low_frequency, defaults.eq_low_frequency),
        }];
        bands.extend(
            peaks.into_iter().map(
                |(peak_gain, peak_frequency, peak_q, default)| EqBand::Peak {
                    gain: gain(peak_gain),
                    frequency: frequency(peak_frequency, default),
                    q: q(peak_q, defaults.eq_mid1_q),
                },
            ),
        );
        bands.push(EqBand::HighShelf {
            gain: gain(self.eq_high_gain),
            frequency: frequency(self.eq_high_frequency, defaults.eq_high_frequency),
        });
        bands.retain(|band| {
            let (EqBand::LowShelf { gain, .. }
            | EqBand::Peak { gain, .. }
            | EqBand::HighShelf { gain, .. }) = band;
            gain.abs() >= NEUTRAL_DB
        });
        bands
    }

    /// The compressor's settings in their ranges, or None when it's off or
    /// would change nothing (a ratio of 1 and no makeup gain).
    pub(crate) fn compressor(&self) -> Option<Compressor> {
        let defaults = AudioEffectSettings::default();
        let compressor = Compressor {
            threshold: clamp(
                self.compressor_threshold,
                -80.0,
                0.0,
                defaults.compressor_threshold,
            ),
            ratio: clamp(self.compressor_ratio, 1.0, 100.0, defaults.compressor_ratio),
            attack: clamp(
                self.compressor_attack,
                0.01,
                1000.0,
                defaults.compressor_attack,
            ),
            release: clamp(
                self.compressor_release,
                1.0,
                5000.0,
                defaults.compressor_release,
            ),
            makeup: clamp(self.compressor_makeup, -30.0, 30.0, 0.0),
        };
        (self.compressor_enabled
            && (compressor.ratio > 1.0 || compressor.makeup.abs() >= NEUTRAL_DB))
            .then_some(compressor)
    }

    /// The echo's settings in their ranges, or None when it's off or mixed
    /// out.
    pub(crate) fn echo(&self) -> Option<Echo> {
        let defaults = AudioEffectSettings::default();
        let echo = Echo {
            delay: clamp(self.echo_delay, 1.0, 5000.0, defaults.echo_delay),
            feedback: clamp(self.echo_feedback, 0.0, 0.95, defaults.echo_feedback),
            mix: clamp(self.echo_mix, 0.0, 1.0, 0.0),
        };
        (self.echo_enabled && echo.mix > 0.0).then_some(echo)
    }

    /// The reverb's settings in their ranges, or None when it's off or mixed
    /// out.
    pub(crate) fn reverb(&self) -> Option<Reverb> {
        let defaults = AudioEffectSettings::default();
        let reverb = Reverb {
            room_size: clamp(self.reverb_room_size, 0.0, 1.0, defaults.reverb_room_size),
            damping: clamp(self.reverb_damping, 0.0, 1.0, defaults.reverb_damping),
            width: clamp(self.reverb_width, 0.0, 1.0, defaults.reverb_width),
            mix: clamp(self.reverb_mix, 0.0, 1.0, 0.0),
        };
        (self.reverb_enabled && reverb.mix > 0.0).then_some(reverb)
    }

    /// Whether any processor would change the sound.
    pub fn is_active(&self) -> bool {
        self.noise_strength() > 0.0
            || self.hum().is_some()
            || self.low_cut_frequency().is_some()
            || !self.eq_bands().is_empty()
            || self.compressor().is_some()
            || self.echo().is_some()
            || self.reverb().is_some()
    }

    /// Whether the sound comes out as it went in.
    pub fn is_identity(&self) -> bool {
        !self.is_active()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_object_is_the_default() {
        let parsed: AudioEffectSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(parsed, AudioEffectSettings::default());
        assert!(parsed.is_identity());
    }

    #[test]
    fn the_keys_are_camel_case() {
        let parsed: AudioEffectSettings = serde_json::from_str(
            r#"{"noiseReduction": 0.5, "eqEnabled": true, "eqMid1Gain": 3, "eqMid1Q": 2, "somethingElse": 1}"#,
        )
        .unwrap();
        assert_eq!(parsed.noise_reduction, 0.5);
        assert!(parsed.eq_enabled);
        assert_eq!(parsed.eq_mid1_gain, 3.0);
        assert_eq!(parsed.eq_mid1_q, 2.0);
        assert_eq!(parsed.eq_mid1_frequency, 400.0);
    }

    #[test]
    fn neutral_settings_change_nothing() {
        let settings = AudioEffectSettings {
            eq_enabled: true,
            compressor_enabled: true,
            compressor_ratio: 1.0,
            echo_enabled: true,
            echo_mix: 0.0,
            reverb_enabled: true,
            reverb_mix: 0.0,
            noise_reduction: f32::NAN,
            ..Default::default()
        };
        assert!(settings.is_identity());
        let settings = AudioEffectSettings {
            eq_enabled: true,
            eq_mid2_gain: 3.0,
            ..Default::default()
        };
        assert!(settings.is_active());
    }
}
