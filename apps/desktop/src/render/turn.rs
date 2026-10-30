// Sources stored on their side (a phone's, held upright), turned on the GPU
// as they're shown before the compositor draws them.

use gpu::{GpuContext, wgpu};

const SHADER: &str = include_str!("turn.wgsl");

pub struct Turner {
    /// By quarter turns clockwise: one, two and three.
    pipelines: [wgpu::RenderPipeline; 3],
}

impl Turner {
    pub fn new(context: &GpuContext) -> Self {
        let device = context.device();
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("export-turn-shader"),
            source: wgpu::ShaderSource::Wgsl(SHADER.into()),
        });
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("export-turn-layout"),
            bind_group_layouts: &[Some(context.texture_sampler_bind_group_layout())],
            immediate_size: 0,
        });
        let pipeline = |entry_point: &str| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("export-turn"),
                layout: Some(&layout),
                vertex: wgpu::VertexState {
                    module: &module,
                    entry_point: Some(entry_point),
                    buffers: &[wgpu::VertexBufferLayout {
                        array_stride: std::mem::size_of::<[f32; 2]>() as u64,
                        step_mode: wgpu::VertexStepMode::Vertex,
                        attributes: &[wgpu::VertexAttribute {
                            format: wgpu::VertexFormat::Float32x2,
                            offset: 0,
                            shader_location: 0,
                        }],
                    }],
                    compilation_options: wgpu::PipelineCompilationOptions::default(),
                },
                fragment: Some(wgpu::FragmentState {
                    module: &module,
                    entry_point: Some("fragment_main"),
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
        };
        Self {
            pipelines: [
                pipeline("quarter"),
                pipeline("half"),
                pipeline("three_quarters"),
            ],
        }
    }

    /// The size a picture is shown at, turned `rotation` degrees.
    pub fn shown_size((width, height): (u32, u32), rotation: u32) -> (u32, u32) {
        if rotation.is_multiple_of(180) {
            (width, height)
        } else {
            (height, width)
        }
    }

    /// Draws `source` into `target`, turned clockwise by `rotation` degrees:
    /// 90, 180 or 270, `target` being the size it's shown at.
    pub fn turn(
        &self,
        context: &GpuContext,
        source: &wgpu::Texture,
        target: &wgpu::Texture,
        rotation: u32,
    ) -> Result<(), String> {
        let pipeline = match rotation {
            90 => &self.pipelines[0],
            180 => &self.pipelines[1],
            270 => &self.pipelines[2],
            _ => return Err(format!("a source turned {rotation} degrees")),
        };
        let device = context.device();
        let source_view = source.create_view(&wgpu::TextureViewDescriptor::default());
        let target_view = target.create_view(&wgpu::TextureViewDescriptor::default());
        // Nearest: a quarter turn puts each pixel on another's place.
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("export-turn-bind-group"),
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
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("export-turn"),
        });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("export-turn"),
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
            pass.set_pipeline(pipeline);
            pass.set_vertex_buffer(0, context.fullscreen_quad().slice(..));
            pass.set_bind_group(0, &bind_group, &[]);
            pass.draw(0..6, 0..1);
        }
        context.queue().submit([encoder.finish()]);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A texture's pixels, the first byte of each, by row.
    fn read(context: &GpuContext, texture: &wgpu::Texture) -> Vec<Vec<u8>> {
        let (width, height) = (texture.width(), texture.height());
        let row = (width * 4).next_multiple_of(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT);
        let buffer = context.device().create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: u64::from(row * height),
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let mut encoder = context
            .device()
            .create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        encoder.copy_texture_to_buffer(
            texture.as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(row),
                    rows_per_image: Some(height),
                },
            },
            texture.size(),
        );
        context.queue().submit([encoder.finish()]);
        buffer.slice(..).map_async(wgpu::MapMode::Read, |_| {});
        context
            .device()
            .poll(wgpu::PollType::wait_indefinitely())
            .unwrap();
        let data = buffer.slice(..).get_mapped_range();
        (0..height)
            .map(|y| {
                (0..width)
                    .map(|x| data[(y * row + x * 4) as usize])
                    .collect()
            })
            .collect()
    }

    #[test]
    fn turns_each_pixel_into_its_place() {
        let Ok(context) = futures_executor::block_on(GpuContext::new()) else {
            eprintln!("No GPU: skipped");
            return;
        };
        let turner = Turner::new(&context);
        // 3x2, each pixel its own: 10 * (its index + 1).
        let (width, height) = (3u32, 2u32);
        let source = context.create_render_texture(width, height, "test-stored");
        let pixels: Vec<u8> = (0..width * height)
            .flat_map(|i| [(i as u8 + 1) * 10, 0, 0, 255])
            .collect();
        context.queue().write_texture(
            source.as_image_copy(),
            &pixels,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(width * 4),
                rows_per_image: Some(height),
            },
            source.size(),
        );
        let stored = |x: u32, y: u32| (y * width + x + 1) as u8 * 10;
        for rotation in [90, 180, 270] {
            let (shown_width, shown_height) = Turner::shown_size((width, height), rotation);
            let target = context.create_render_texture(shown_width, shown_height, "test-shown");
            turner.turn(&context, &source, &target, rotation).unwrap();
            let expected: Vec<Vec<u8>> = (0..shown_height)
                .map(|y| {
                    (0..shown_width)
                        .map(|x| match rotation {
                            // The stored picture's bottom left is shown at the top left.
                            90 => stored(y, height - 1 - x),
                            180 => stored(width - 1 - x, height - 1 - y),
                            _ => stored(width - 1 - y, x),
                        })
                        .collect()
                })
                .collect();
            assert_eq!(read(&context, &target), expected, "{rotation} degrees");
        }
        assert!(turner.turn(&context, &source, &source, 45).is_err());
    }
}
