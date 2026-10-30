//! The pass that draws a transition between two layers, with the shaders of
//! the gl-transitions collection, each compiled the first time it's used.

use std::collections::HashMap;

use gl_transitions::{ParamType, ParamValues, Transition, Value};
use gpu::{FULLSCREEN_SHADER_SOURCE, GpuContext, wgpu};

use crate::frame::TransitionParamValue;

const VERTEX_SHADER_SOURCE: &str = include_str!("shaders/transition.wgsl");
const ALPHA_SHADER_SOURCE: &str = include_str!("shaders/alpha.wgsl");

/// What a transition that isn't there, or needs more images than the two it
/// goes between, falls back to.
const FALLBACK: &str = "Fade";

/// A transition by its gl-transitions name, if this pass can draw it.
pub fn find_transition(name: &str) -> &'static Transition {
    let usable =
        |transition: &&Transition| transition.wgsl().is_some() && transition.textures().is_empty();
    gl_transitions::get(name)
        .filter(usable)
        .or_else(|| gl_transitions::get(FALLBACK))
        .expect("Fade is in the collection")
}

/// The transition's parameters: its defaults, with the given values that have
/// the type it declares.
pub fn transition_params(
    transition: &'static Transition,
    values: &HashMap<String, TransitionParamValue>,
) -> ParamValues {
    let mut params = transition.default_params();
    for (name, value) in values {
        let Some(param) = transition.param(name) else {
            continue;
        };
        if let Some(value) = typed_value(param.ty, value) {
            // The type is the parameter's: set can't fail.
            let _ = params.set(name, value);
        }
    }
    params
}

fn typed_value(ty: ParamType, value: &TransitionParamValue) -> Option<Value> {
    let vector = |count: usize| match value {
        TransitionParamValue::Vector(values) if values.len() == count => Some(values.as_slice()),
        _ => None,
    };
    let integer = |value: f32| value.round() as i32;
    Some(match (ty, value) {
        (ParamType::Float, TransitionParamValue::Number(n)) => Value::Float(*n),
        (ParamType::Int, TransitionParamValue::Number(n)) => Value::Int(integer(*n)),
        (ParamType::Bool, TransitionParamValue::Bool(b)) => Value::Bool(*b),
        (ParamType::Vec2, _) => {
            let v = vector(2)?;
            Value::Vec2([v[0], v[1]])
        }
        (ParamType::Vec3, _) => {
            let v = vector(3)?;
            Value::Vec3([v[0], v[1], v[2]])
        }
        (ParamType::Vec4, _) => {
            let v = vector(4)?;
            Value::Vec4([v[0], v[1], v[2], v[3]])
        }
        (ParamType::IVec2, _) => {
            let v = vector(2)?;
            Value::IVec2([integer(v[0]), integer(v[1])])
        }
        (ParamType::IVec3, _) => {
            let v = vector(3)?;
            Value::IVec3([integer(v[0]), integer(v[1]), integer(v[2])])
        }
        (ParamType::IVec4, _) => {
            let v = vector(4)?;
            Value::IVec4([integer(v[0]), integer(v[1]), integer(v[2]), integer(v[3])])
        }
        _ => return None,
    })
}

pub struct ApplyTransitionOptions<'a> {
    pub from: &'a wgpu::Texture,
    pub to: &'a wgpu::Texture,
    pub target: &'a wgpu::Texture,
    pub params: &'a ParamValues,
    pub progress: f32,
    pub width: u32,
    pub height: u32,
}

/// Which way to convert a texture's alpha.
#[derive(Clone, Copy)]
pub enum Alpha {
    Premultiply,
    Unpremultiply,
}

pub struct TransitionPipeline {
    vertex_shader: wgpu::ShaderModule,
    bind_group_layout: wgpu::BindGroupLayout,
    pipeline_layout: wgpu::PipelineLayout,
    pipelines: HashMap<&'static str, wgpu::RenderPipeline>,
    premultiply: wgpu::RenderPipeline,
    unpremultiply: wgpu::RenderPipeline,
}

fn alpha_pipeline(
    context: &GpuContext,
    vertex_shader: &wgpu::ShaderModule,
    alpha_shader: &wgpu::ShaderModule,
    entry_point: &'static str,
) -> wgpu::RenderPipeline {
    let device = context.device();
    let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("compositor-alpha-pipeline-layout"),
        bind_group_layouts: &[Some(context.texture_sampler_bind_group_layout())],
        immediate_size: 0,
    });
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some(entry_point),
        layout: Some(&layout),
        vertex: wgpu::VertexState {
            module: vertex_shader,
            entry_point: Some("vertex_main"),
            buffers: &[QUAD_LAYOUT],
            compilation_options: wgpu::PipelineCompilationOptions::default(),
        },
        fragment: Some(wgpu::FragmentState {
            module: alpha_shader,
            entry_point: Some(entry_point),
            targets: &[Some(wgpu::ColorTargetState {
                format: context.texture_format(),
                blend: None,
                write_mask: wgpu::ColorWrites::ALL,
            })],
            compilation_options: wgpu::PipelineCompilationOptions::default(),
        }),
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        multiview_mask: None,
        cache: None,
    })
}

/// The fullscreen quad's vertices: positions.
const QUAD_LAYOUT: wgpu::VertexBufferLayout<'static> = wgpu::VertexBufferLayout {
    array_stride: std::mem::size_of::<[f32; 2]>() as u64,
    step_mode: wgpu::VertexStepMode::Vertex,
    attributes: &[wgpu::VertexAttribute {
        format: wgpu::VertexFormat::Float32x2,
        offset: 0,
        shader_location: 0,
    }],
};

impl TransitionPipeline {
    pub fn new(context: &GpuContext) -> Self {
        let device = context.device();
        let vertex_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("compositor-transition-vertex-shader"),
            source: wgpu::ShaderSource::Wgsl(VERTEX_SHADER_SOURCE.into()),
        });
        let texture = |binding| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Texture {
                multisampled: false,
                view_dimension: wgpu::TextureViewDimension::D2,
                sample_type: wgpu::TextureSampleType::Float { filterable: true },
            },
            count: None,
        };
        // The collection's bindings: the uniforms, a sampler, from, to.
        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("compositor-transition-layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
                texture(2),
                texture(3),
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("compositor-transition-pipeline-layout"),
            bind_group_layouts: &[Some(&bind_group_layout)],
            immediate_size: 0,
        });
        let fullscreen_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("compositor-alpha-vertex-shader"),
            source: wgpu::ShaderSource::Wgsl(FULLSCREEN_SHADER_SOURCE.into()),
        });
        let alpha_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("compositor-alpha-shader"),
            source: wgpu::ShaderSource::Wgsl(ALPHA_SHADER_SOURCE.into()),
        });
        let premultiply = alpha_pipeline(context, &fullscreen_shader, &alpha_shader, "premultiply");
        let unpremultiply =
            alpha_pipeline(context, &fullscreen_shader, &alpha_shader, "unpremultiply");
        Self {
            vertex_shader,
            bind_group_layout,
            pipeline_layout,
            pipelines: HashMap::new(),
            premultiply,
            unpremultiply,
        }
    }

    /// The source, its alpha converted, into the target.
    pub fn convert_alpha_with_encoder(
        &self,
        context: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        source: &wgpu::Texture,
        target: &wgpu::Texture,
        alpha: Alpha,
    ) {
        let source_view = source.create_view(&wgpu::TextureViewDescriptor::default());
        let target_view = target.create_view(&wgpu::TextureViewDescriptor::default());
        let bind_group = context
            .device()
            .create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("compositor-alpha-bind-group"),
                layout: context.texture_sampler_bind_group_layout(),
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(&source_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::Sampler(context.nearest_sampler()),
                    },
                ],
            });
        let mut render_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("compositor-alpha-pass"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &target_view,
                resolve_target: None,
                depth_slice: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            occlusion_query_set: None,
            timestamp_writes: None,
            multiview_mask: None,
        });
        render_pass.set_pipeline(match alpha {
            Alpha::Premultiply => &self.premultiply,
            Alpha::Unpremultiply => &self.unpremultiply,
        });
        render_pass.set_vertex_buffer(0, context.fullscreen_quad().slice(..));
        render_pass.set_bind_group(0, &bind_group, &[]);
        render_pass.draw(0..6, 0..1);
    }

    fn pipeline(
        &mut self,
        context: &GpuContext,
        transition: &'static Transition,
    ) -> &wgpu::RenderPipeline {
        let Self {
            vertex_shader,
            pipeline_layout,
            pipelines,
            ..
        } = self;
        pipelines.entry(transition.name()).or_insert_with(|| {
            let device = context.device();
            let fragment_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some(transition.name()),
                source: wgpu::ShaderSource::Wgsl(transition.wgsl().unwrap_or_default().into()),
            });
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("compositor-transition-pipeline"),
                layout: Some(pipeline_layout),
                vertex: wgpu::VertexState {
                    module: vertex_shader,
                    entry_point: Some("vertex_main"),
                    buffers: &[QUAD_LAYOUT],
                    compilation_options: wgpu::PipelineCompilationOptions::default(),
                },
                fragment: Some(wgpu::FragmentState {
                    module: &fragment_shader,
                    entry_point: Some("main"),
                    targets: &[Some(wgpu::ColorTargetState {
                        format: context.texture_format(),
                        blend: None,
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                    compilation_options: wgpu::PipelineCompilationOptions::default(),
                }),
                primitive: wgpu::PrimitiveState::default(),
                depth_stencil: None,
                multisample: wgpu::MultisampleState::default(),
                multiview_mask: None,
                cache: None,
            })
        })
    }

    pub fn apply_with_encoder(
        &mut self,
        context: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        options: ApplyTransitionOptions<'_>,
    ) {
        let ratio = options.width as f32 / options.height.max(1) as f32;
        let mut uniforms = options
            .params
            .uniform_buffer(options.progress, ratio)
            .unwrap_or_else(|| vec![0; 16]);
        // WebGL wants uniform buffers in multiples of 16 bytes.
        uniforms.resize(uniforms.len().next_multiple_of(16), 0);

        let device = context.device();
        let uniform_buffer = wgpu::util::DeviceExt::create_buffer_init(
            device,
            &wgpu::util::BufferInitDescriptor {
                label: Some("compositor-transition-uniform-buffer"),
                contents: &uniforms,
                usage: wgpu::BufferUsages::UNIFORM,
            },
        );
        let from_view = options
            .from
            .create_view(&wgpu::TextureViewDescriptor::default());
        let to_view = options
            .to
            .create_view(&wgpu::TextureViewDescriptor::default());
        let target_view = options
            .target
            .create_view(&wgpu::TextureViewDescriptor::default());
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("compositor-transition-bind-group"),
            layout: &self.bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: uniform_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(context.linear_sampler()),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(&from_view),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::TextureView(&to_view),
                },
            ],
        });

        let pipeline = self.pipeline(context, options.params.transition());
        let mut render_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("compositor-transition-pass"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &target_view,
                resolve_target: None,
                depth_slice: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            occlusion_query_set: None,
            timestamp_writes: None,
            multiview_mask: None,
        });
        render_pass.set_pipeline(pipeline);
        render_pass.set_vertex_buffer(0, context.fullscreen_quad().slice(..));
        render_pass.set_bind_group(0, &bind_group, &[]);
        render_pass.draw(0..6, 0..1);
    }
}
