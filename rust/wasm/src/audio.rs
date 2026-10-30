#![cfg(target_arch = "wasm32")]

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
    let channels: Array = Reflect::get(&object, &JsValue::from_str("channels"))?
        .dyn_into()
        .map_err(|_| JsValue::from_str("Property 'channels' must be an array"))?;
    let channels = channels
        .iter()
        .map(|channel| {
            channel
                .dyn_into::<Float32Array>()
                .map(|channel| channel.to_vec())
                .map_err(|_| JsValue::from_str("Each channel must be a Float32Array"))
        })
        .collect::<Result<Vec<_>, _>>()?;
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
    Ok(stretched
        .iter()
        .map(|channel| Float32Array::from(channel.as_slice()))
        .collect())
}
