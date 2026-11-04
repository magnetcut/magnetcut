#![cfg(target_arch = "wasm32")]

use audio::AudioEffectSettings;
use js_sys::{Array, Float32Array, Object, Reflect};
use wasm_bindgen::{JsCast, JsValue, prelude::wasm_bindgen};

use crate::gpu::read_u32_property;

#[wasm_bindgen(typescript_custom_section)]
const TIME_STRETCH_OPTIONS: &str = r#"
export interface TimeStretchOptions {
    /** One per channel, all the same length. */
    channels: Float32Array[];
    sampleRate: number;
    /** How much faster the result plays: 2 takes half as long. */
    tempo: number;
    /** Samples per channel in the result. */
    outputLength: number;
}
"#;

/// Changes audio's speed without changing its pitch (`audio::time_stretch`).
/// The samples are copied in and out as whole arrays: through serde, a minute
/// of audio would be millions of values one by one.
#[wasm_bindgen(js_name = timeStretch, unchecked_return_type = "Float32Array[]")]
pub fn time_stretch(
    #[wasm_bindgen(unchecked_param_type = "TimeStretchOptions")] options: JsValue,
) -> Result<Array, JsValue> {
    let object: Object = options
        .dyn_into()
        .map_err(|_| JsValue::from_str("timeStretch expects an options object"))?;
    let channels = read_channels(Reflect::get(&object, &JsValue::from_str("channels"))?)?;
    let tempo = Reflect::get(&object, &JsValue::from_str("tempo"))?
        .as_f64()
        .ok_or_else(|| JsValue::from_str("Property 'tempo' must be a number"))?;

    let slices: Vec<&[f32]> = channels.iter().map(Vec::as_slice).collect();
    let stretched = audio::time_stretch(audio::TimeStretchOptions {
        channels: &slices,
        sample_rate: read_u32_property(&object, "sampleRate")?,
        tempo,
        output_length: read_u32_property(&object, "outputLength")? as usize,
    });
    Ok(to_arrays(&stretched))
}

#[wasm_bindgen(typescript_custom_section)]
const AUDIO_EFFECT_SETTINGS: &str = r#"
/**
 * What's done to a clip's sound, in this order: noise, hum, low cut,
 * equaliser, compressor, echo, reverb. Every key is optional: what's left out
 * is off or neutral, so `{}` changes nothing.
 */
export interface AudioEffectSettings {
    /** RNNoise, for voices: 0 (off) to 1, the original mixed back in below 1. */
    noiseReduction?: number;
    /** Notches at this mains frequency and its harmonics, 50 or 60 Hz; 0 is off. */
    humFrequency?: number;
    /** A 4th-order Butterworth high-pass, Hz; 0 is off. */
    lowCut?: number;
    eqEnabled?: boolean;
    /** Low shelf, dB (default 0) and Hz (100). */
    eqLowGain?: number;
    eqLowFrequency?: number;
    /** Peaks, dB (default 0), Hz (400, 1500, 4000) and Q (1). */
    eqMid1Gain?: number;
    eqMid1Frequency?: number;
    eqMid1Q?: number;
    eqMid2Gain?: number;
    eqMid2Frequency?: number;
    eqMid2Q?: number;
    eqMid3Gain?: number;
    eqMid3Frequency?: number;
    eqMid3Q?: number;
    /** High shelf, dB (default 0) and Hz (10000). */
    eqHighGain?: number;
    eqHighFrequency?: number;
    compressorEnabled?: boolean;
    /** dBFS, -80 to 0 (default -20). */
    compressorThreshold?: number;
    /** 1 to 100 (default 4). */
    compressorRatio?: number;
    /** Milliseconds (defaults 10 and 150). */
    compressorAttack?: number;
    compressorRelease?: number;
    /** dB, -30 to 30 (default 0). */
    compressorMakeup?: number;
    echoEnabled?: boolean;
    /** Milliseconds, 1 to 5000 (default 300). */
    echoDelay?: number;
    /** Each echo beside the one before, 0 to 0.95 (default 0.35). */
    echoFeedback?: number;
    /** 0 the original alone, 1 the echoes alone (default 0.3). */
    echoMix?: number;
    reverbEnabled?: boolean;
    /** Freeverb's, all 0 to 1 (defaults 0.5, 0.5, 1, 0.25); mix 1 is the reverb alone. */
    reverbRoomSize?: number;
    reverbDamping?: number;
    reverbWidth?: number;
    reverbMix?: number;
}

export interface ApplyAudioEffectsOptions {
    /** One per channel, all the same length. */
    channels: Float32Array[];
    sampleRate: number;
    settings: AudioEffectSettings;
}
"#;

/// A whole clip's sound through its effects (`audio::apply_audio_effects`):
/// as long as the input and lined up with it.
#[wasm_bindgen(js_name = applyAudioEffects, unchecked_return_type = "Float32Array[]")]
pub fn apply_audio_effects(
    #[wasm_bindgen(unchecked_param_type = "ApplyAudioEffectsOptions")] options: JsValue,
) -> Result<Array, JsValue> {
    let object: Object = options
        .dyn_into()
        .map_err(|_| JsValue::from_str("applyAudioEffects expects an options object"))?;
    let channels = read_channels(Reflect::get(&object, &JsValue::from_str("channels"))?)?;
    check_lengths(&channels)?;
    let settings = read_settings(Reflect::get(&object, &JsValue::from_str("settings"))?)?;
    let slices: Vec<&[f32]> = channels.iter().map(Vec::as_slice).collect();
    let processed = audio::apply_audio_effects(audio::ApplyAudioEffectsOptions {
        channels: &slices,
        sample_rate: read_u32_property(&object, "sampleRate")?,
        settings: &settings,
    });
    Ok(to_arrays(&processed))
}

/// A clip's effects with their state, for streaming its sound through them a
/// block at a time (`audio::AudioEffectsChain`).
#[wasm_bindgen]
pub struct AudioEffectsChain {
    chain: audio::AudioEffectsChain,
    channels: usize,
}

#[wasm_bindgen]
impl AudioEffectsChain {
    #[wasm_bindgen(constructor)]
    pub fn new(
        #[wasm_bindgen(unchecked_param_type = "AudioEffectSettings")] settings: JsValue,
        #[wasm_bindgen(js_name = "sampleRate")] sample_rate: u32,
        #[wasm_bindgen(js_name = "channelCount")] channel_count: usize,
    ) -> Result<AudioEffectsChain, JsValue> {
        let settings = read_settings(settings)?;
        Ok(AudioEffectsChain {
            chain: audio::AudioEffectsChain::new(&settings, sample_rate, channel_count),
            channels: channel_count,
        })
    }

    /// How many samples late what `process` gives back is: 0 unless the noise
    /// reduction is on.
    #[wasm_bindgen(getter)]
    pub fn latency(&self) -> usize {
        self.chain.latency()
    }

    /// Whether every effect is off, so the sound needn't go through.
    #[wasm_bindgen(getter, js_name = isIdentity)]
    pub fn is_identity(&self) -> bool {
        self.chain.is_identity()
    }

    /// The next block, one array per channel, all the same length, of any
    /// size; as many samples come back, `latency` late.
    #[wasm_bindgen(unchecked_return_type = "Float32Array[]")]
    pub fn process(
        &mut self,
        #[wasm_bindgen(unchecked_param_type = "Float32Array[]")] channels: JsValue,
    ) -> Result<Array, JsValue> {
        let channels = read_channels(channels)?;
        check_count(&channels, self.channels)?;
        check_lengths(&channels)?;
        let slices: Vec<&[f32]> = channels.iter().map(Vec::as_slice).collect();
        Ok(to_arrays(&self.chain.process(&slices)))
    }
}

/// Loudness as ITU-R BS.1770-4 and EBU R128 measure it, of a sound streamed
/// through a block at a time (`audio::LoudnessMeter`): the same however it's
/// split into blocks.
#[wasm_bindgen]
pub struct LoudnessMeter {
    meter: audio::LoudnessMeter,
    channels: usize,
}

#[wasm_bindgen]
impl LoudnessMeter {
    /// Six channels are taken as 5.1, in the order L R C LFE Ls Rs.
    #[wasm_bindgen(constructor)]
    pub fn new(
        #[wasm_bindgen(js_name = "sampleRate")] sample_rate: u32,
        #[wasm_bindgen(js_name = "channelCount")] channel_count: usize,
    ) -> LoudnessMeter {
        LoudnessMeter {
            meter: audio::LoudnessMeter::new(sample_rate, channel_count),
            channels: channel_count,
        }
    }

    /// The next block, one array per channel, all the same length, of any
    /// size.
    pub fn push(
        &mut self,
        #[wasm_bindgen(unchecked_param_type = "Float32Array[]")] channels: JsValue,
    ) -> Result<(), JsValue> {
        let channels = read_channels(channels)?;
        check_count(&channels, self.channels)?;
        check_lengths(&channels)?;
        let slices: Vec<&[f32]> = channels.iter().map(Vec::as_slice).collect();
        self.meter.push(&slices);
        Ok(())
    }

    /// The integrated loudness, LUFS, gated at -70 LUFS and 10 LU under the
    /// mean: undefined until 400 ms of it is over -70 LUFS.
    #[wasm_bindgen(getter)]
    pub fn integrated(&self) -> Option<f64> {
        self.meter.integrated()
    }

    /// The true peak, dBTP: the loudest channel's, 4x oversampled, never
    /// under the sample peak. -Infinity for silence.
    #[wasm_bindgen(getter, js_name = truePeak)]
    pub fn true_peak(&self) -> f64 {
        self.meter.true_peak()
    }

    /// The loudness range, LU (EBU Tech 3342): undefined until 3 s of it is
    /// over -70 LUFS.
    #[wasm_bindgen(getter, js_name = loudnessRange)]
    pub fn loudness_range(&self) -> Option<f64> {
        self.meter.loudness_range()
    }
}

/// Settings from the editor. Keys set to undefined or null are left out, as
/// if missing: serde would refuse them as numbers.
fn read_settings(value: JsValue) -> Result<AudioEffectSettings, JsValue> {
    if value.is_undefined() || value.is_null() {
        return Ok(AudioEffectSettings::default());
    }
    let object: Object = value
        .dyn_into()
        .map_err(|_| JsValue::from_str("The audio effect settings must be an object"))?;
    let defined = Object::new();
    for entry in Object::entries(&object).iter() {
        let entry: Array = entry.unchecked_into();
        let value = entry.get(1);
        if !value.is_undefined() && !value.is_null() {
            Reflect::set(&defined, &entry.get(0), &value)?;
        }
    }
    serde_wasm_bindgen::from_value(defined.into())
        .map_err(|error| JsValue::from_str(&format!("Invalid audio effect settings: {error}")))
}

fn read_channels(value: JsValue) -> Result<Vec<Vec<f32>>, JsValue> {
    let channels: Array = value
        .dyn_into()
        .map_err(|_| JsValue::from_str("Property 'channels' must be an array"))?;
    channels
        .iter()
        .map(|channel| {
            channel
                .dyn_into::<Float32Array>()
                .map(|channel| channel.to_vec())
                .map_err(|_| JsValue::from_str("Each channel must be a Float32Array"))
        })
        .collect()
}

fn check_count(channels: &[Vec<f32>], expected: usize) -> Result<(), JsValue> {
    if channels.len() == expected {
        Ok(())
    } else {
        Err(JsValue::from_str(&format!(
            "Expected {expected} channels, got {}",
            channels.len()
        )))
    }
}

fn check_lengths(channels: &[Vec<f32>]) -> Result<(), JsValue> {
    let length = channels.first().map_or(0, Vec::len);
    if channels.iter().all(|channel| channel.len() == length) {
        Ok(())
    } else {
        Err(JsValue::from_str("The channels' lengths differ"))
    }
}

fn to_arrays(channels: &[Vec<f32>]) -> Array {
    channels
        .iter()
        .map(|channel| Float32Array::from(channel.as_slice()))
        .collect()
}
