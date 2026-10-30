//! What each gl-transitions shader takes, for an interface: its parameters,
//! their types, defaults and suggested ranges.

use bridge::export;
use gl_transitions::{ParamType, Value};
use serde::{Deserialize, Serialize};

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Serialize, Clone, Copy, Debug, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ShaderParamKind {
    Float,
    Int,
    Bool,
    Vec2,
    Vec3,
    Vec4,
    IVec2,
    IVec3,
    IVec4,
}

/// A value as projects keep it: a number, a flag or a vector.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(untagged)]
pub enum ShaderParamValue {
    Number(f32),
    Bool(bool),
    Vector(Vec<f32>),
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShaderParam {
    pub name: String,
    pub kind: ShaderParamKind,
    pub default: ShaderParamValue,
    #[cfg_attr(feature = "wasm", tsify(optional))]
    pub min: Option<f32>,
    #[cfg_attr(feature = "wasm", tsify(optional))]
    pub max: Option<f32>,
    #[cfg_attr(feature = "wasm", tsify(optional))]
    pub step: Option<f32>,
    /// RGB or RGBA, from 0 to 1.
    pub color: bool,
    #[cfg_attr(feature = "wasm", tsify(optional))]
    pub description: Option<String>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShaderInfo {
    pub name: String,
    #[cfg_attr(feature = "wasm", tsify(optional))]
    pub description: Option<String>,
    pub params: Vec<ShaderParam>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ShaderInfoOptions {
    /// Its gl-transitions name, such as `Fade`.
    pub shader: String,
}

// Both enums are open: a kind a later version adds isn't offered.
fn kind(ty: ParamType) -> Option<ShaderParamKind> {
    Some(match ty {
        ParamType::Float => ShaderParamKind::Float,
        ParamType::Int => ShaderParamKind::Int,
        ParamType::Bool => ShaderParamKind::Bool,
        ParamType::Vec2 => ShaderParamKind::Vec2,
        ParamType::Vec3 => ShaderParamKind::Vec3,
        ParamType::Vec4 => ShaderParamKind::Vec4,
        ParamType::IVec2 => ShaderParamKind::IVec2,
        ParamType::IVec3 => ShaderParamKind::IVec3,
        ParamType::IVec4 => ShaderParamKind::IVec4,
        _ => return None,
    })
}

fn value(value: Value) -> Option<ShaderParamValue> {
    let integers = |values: &[i32]| values.iter().map(|&v| v as f32).collect();
    Some(match value {
        Value::Float(v) => ShaderParamValue::Number(v),
        Value::Int(v) => ShaderParamValue::Number(v as f32),
        Value::Bool(v) => ShaderParamValue::Bool(v),
        Value::Vec2(v) => ShaderParamValue::Vector(v.to_vec()),
        Value::Vec3(v) => ShaderParamValue::Vector(v.to_vec()),
        Value::Vec4(v) => ShaderParamValue::Vector(v.to_vec()),
        Value::IVec2(v) => ShaderParamValue::Vector(integers(&v)),
        Value::IVec3(v) => ShaderParamValue::Vector(integers(&v)),
        Value::IVec4(v) => ShaderParamValue::Vector(integers(&v)),
        _ => return None,
    })
}

/// A shader's parameters; none for one not in the collection.
#[export]
pub fn shader_info(ShaderInfoOptions { shader }: ShaderInfoOptions) -> Option<ShaderInfo> {
    let transition = gl_transitions::get(&shader)?;
    Some(ShaderInfo {
        name: transition.name().to_string(),
        description: transition.description().map(str::to_string),
        params: transition
            .params()
            .iter()
            .filter_map(|param| {
                Some(ShaderParam {
                    name: param.name.to_string(),
                    kind: kind(param.ty)?,
                    default: value(param.default)?,
                    min: param.min,
                    max: param.max,
                    step: param.step,
                    color: param.color,
                    description: param.description.map(str::to_string),
                })
            })
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(shader: &str) -> Option<ShaderInfo> {
        shader_info(ShaderInfoOptions {
            shader: shader.to_string(),
        })
    }

    #[test]
    fn a_shader_s_parameters() {
        let fade_color = info("FadeColor").expect("FadeColor is in the collection");
        let color = &fade_color.params[0];
        assert_eq!(color.name, "color");
        assert_eq!(color.kind, ShaderParamKind::Vec4);
        assert_eq!(
            color.default,
            ShaderParamValue::Vector(vec![0.0, 0.0, 0.0, 1.0])
        );
        assert!(color.color);
        let phase = &fade_color.params[1];
        assert_eq!((phase.min, phase.max), (Some(0.0), Some(1.0)));
    }

    #[test]
    fn integers_and_flags() {
        let slides = info("Slides").expect("Slides is in the collection");
        assert_eq!(slides.params[0].kind, ShaderParamKind::Int);
        assert_eq!(slides.params[0].default, ShaderParamValue::Number(0.0));
        assert_eq!(slides.params[1].default, ShaderParamValue::Bool(false));
    }

    #[test]
    fn none_for_an_unknown_shader() {
        assert!(info("NoSuchTransition").is_none());
        assert!(info("Fade").expect("Fade is there").params.is_empty());
    }
}
