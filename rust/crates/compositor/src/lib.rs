// A render pass takes the GPU, its encoder, its textures and their size.
#![allow(clippy::too_many_arguments)]

mod blend_mode;
mod compositor;
mod frame;
mod texture_pool;
mod texture_store;
mod transition;

pub use blend_mode::BlendMode;
pub use compositor::{Compositor, CompositorError, RenderFrameOptions};
pub use frame::{
    CanvasClearDescriptor, CanvasTextureDescriptor, EffectPassDescriptor, FrameDescriptor,
    FrameItemDescriptor, LayerDescriptor, LayerMaskDescriptor, QuadTransformDescriptor,
    TransitionDescriptor, TransitionParamValue,
};
pub use transition::{RenderTransitionOptions, TransitionPipeline};

#[cfg(test)]
mod tests;
