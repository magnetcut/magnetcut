use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::BlendMode;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameDescriptor {
    pub width: u32,
    pub height: u32,
    pub clear: CanvasClearDescriptor,
    pub items: Vec<FrameItemDescriptor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasClearDescriptor {
    pub color: [f32; 4],
}

// A frame has a handful of items: boxing transitions would only add allocations.
// The fields camelCase too, as the editor sends them: without, a scene effect
// was refused ("missing field `effect_pass_groups`").
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum FrameItemDescriptor {
    Layer(LayerDescriptor),
    /// Effects on everything drawn so far: an adjustment layer. With a mask,
    /// only within it (a Hide region, docs/HIDE.md).
    SceneEffect {
        effect_pass_groups: Vec<Vec<EffectPassDescriptor>>,
        #[serde(default)]
        mask: Option<LayerMaskDescriptor>,
    },
    Transition(TransitionDescriptor),
}

/// Two layers, drawn into one by a transition, then blended into the scene.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransitionDescriptor {
    /// The outgoing clip: none when it has nothing to show (transparent).
    pub from: Option<LayerDescriptor>,
    /// The incoming clip.
    pub to: Option<LayerDescriptor>,
    /// Its gl-transitions name, e.g. "Fade".
    pub transition: String,
    /// Its parameters, by name: the defaults for those not given.
    #[serde(default)]
    pub params: HashMap<String, TransitionParamValue>,
    /// From 0, the outgoing clip, to 1, the incoming one.
    pub progress: f32,
    pub blend_mode: BlendMode,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum TransitionParamValue {
    Bool(bool),
    Number(f32),
    Vector(Vec<f32>),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerDescriptor {
    pub texture_id: String,
    pub transform: QuadTransformDescriptor,
    pub opacity: f32,
    pub blend_mode: BlendMode,
    #[serde(default)]
    pub effect_pass_groups: Vec<Vec<EffectPassDescriptor>>,
    /// Passes on the source picture at its own size, before it's placed:
    /// Export's filters, which need the source's own lines.
    #[serde(default)]
    pub source_effect_pass_groups: Vec<Vec<EffectPassDescriptor>>,
    pub mask: Option<LayerMaskDescriptor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuadTransformDescriptor {
    pub center_x: f32,
    pub center_y: f32,
    pub width: f32,
    pub height: f32,
    pub rotation_degrees: f32,
    pub flip_x: bool,
    pub flip_y: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerMaskDescriptor {
    pub texture_id: String,
    pub feather: f32,
    pub inverted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectPassDescriptor {
    pub shader: String,
    pub uniforms: HashMap<String, EffectUniformValueDescriptor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum EffectUniformValueDescriptor {
    Number(f32),
    Vector(Vec<f32>),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasTextureDescriptor {
    pub id: String,
    pub width: u32,
    pub height: u32,
}
