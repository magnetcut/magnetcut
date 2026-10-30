#![cfg(target_arch = "wasm32")]

use std::collections::HashMap;

use compositor::{RenderTransitionOptions, TransitionParamValue};
use gpu::wgpu;
use js_sys::Object;
use wasm_bindgen::{JsCast, JsValue, prelude::wasm_bindgen};

use crate::compositor::restore_compositor_canvas;
use crate::gpu::{
    import_canvas_texture, read_f32_property, read_offscreen_canvas_property, read_serde_property,
    read_u32_property, render_texture_to_canvas, with_gpu_runtime,
};

/// A transition between two images at one point of its progress, for the
/// catalogue's thumbnails.
#[wasm_bindgen(js_name = applyTransition)]
pub fn apply_transition(options: JsValue) -> Result<wgpu::web_sys::OffscreenCanvas, JsValue> {
    let object: Object = options
        .dyn_into()
        .map_err(|_| JsValue::from_str("applyTransition expects an options object"))?;
    let from = read_offscreen_canvas_property(&object, "from")?;
    let to = read_offscreen_canvas_property(&object, "to")?;
    let width = read_u32_property(&object, "width")?;
    let height = read_u32_property(&object, "height")?;
    let transition: String = read_serde_property(&object, "transition")?;
    let params: HashMap<String, TransitionParamValue> = read_serde_property(&object, "params")?;
    let progress = read_f32_property(&object, "progress")?;

    with_gpu_runtime(|runtime| {
        let context = &runtime.context;
        let from = import_canvas_texture(context, &from, width, height, "transition-preview-from");
        let to = import_canvas_texture(context, &to, width, height, "transition-preview-to");
        let texture = runtime.transitions.borrow_mut().render(
            context,
            RenderTransitionOptions {
                from: &from,
                to: &to,
                transition: &transition,
                params: &params,
                progress,
                width,
                height,
            },
        );
        let canvas = render_texture_to_canvas(context, &texture, width, height);
        restore_compositor_canvas(context);
        canvas
    })
}
