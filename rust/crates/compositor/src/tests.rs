//! Frames drawn by the compositor on this machine's GPU, checked pixel by
//! pixel. Without a GPU they pass, saying so.

use std::collections::HashMap;

use gpu::{GpuContext, wgpu};

use crate::frame::EffectUniformValueDescriptor;
use crate::transition::padded_wgsl;
use crate::{
    BlendMode, CanvasClearDescriptor, Compositor, EffectPassDescriptor, FrameDescriptor,
    FrameItemDescriptor, LayerDescriptor, QuadTransformDescriptor, TransitionDescriptor,
    TransitionParamValue,
};

const SIZE: u32 = 64;
const RED: [u8; 4] = [255, 0, 0, 255];
const BLUE: [u8; 4] = [0, 0, 255, 255];

fn gpu() -> Option<(GpuContext, Compositor)> {
    let Ok(context) = futures_executor::block_on(GpuContext::new()) else {
        eprintln!("no GPU: not checked");
        return None;
    };
    let mut compositor = Compositor::new(&context);
    for (id, color) in [("red", RED), ("blue", BLUE)] {
        compositor.upsert_texture(id.to_owned(), solid(&context, color));
    }
    Some((context, compositor))
}

/// Texture bytes in the context's format, from RGBA.
fn texel(context: &GpuContext, [r, g, b, a]: [u8; 4]) -> [u8; 4] {
    match context.texture_format() {
        wgpu::TextureFormat::Bgra8Unorm => [b, g, r, a],
        _ => [r, g, b, a],
    }
}

fn solid(context: &GpuContext, color: [u8; 4]) -> wgpu::Texture {
    let texture = context.create_render_texture(SIZE, SIZE, "test-solid");
    let data = texel(context, color).repeat((SIZE * SIZE) as usize);
    context.queue().write_texture(
        wgpu::TexelCopyTextureInfo {
            texture: &texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        &data,
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(4 * SIZE),
            rows_per_image: Some(SIZE),
        },
        wgpu::Extent3d {
            width: SIZE,
            height: SIZE,
            depth_or_array_layers: 1,
        },
    );
    texture
}

fn layer(texture_id: &str) -> LayerDescriptor {
    LayerDescriptor {
        texture_id: texture_id.to_owned(),
        transform: QuadTransformDescriptor {
            center_x: SIZE as f32 / 2.0,
            center_y: SIZE as f32 / 2.0,
            width: SIZE as f32,
            height: SIZE as f32,
            rotation_degrees: 0.0,
            flip_x: false,
            flip_y: false,
        },
        opacity: 1.0,
        blend_mode: BlendMode::Normal,
        effect_pass_groups: Vec::new(),
        source_effect_pass_groups: Vec::new(),
        mask: None,
    }
}

fn transition(name: &str, progress: f32) -> TransitionDescriptor {
    TransitionDescriptor {
        from: Some(layer("red")),
        to: Some(layer("blue")),
        transition: name.to_owned(),
        params: HashMap::new(),
        progress,
        blend_mode: BlendMode::Normal,
    }
}

/// The frame's pixels, RGBA, row by row from the top.
fn render(
    context: &GpuContext,
    compositor: &mut Compositor,
    transition: TransitionDescriptor,
) -> Vec<[u8; 4]> {
    render_items(
        context,
        compositor,
        vec![FrameItemDescriptor::Transition(transition)],
    )
}

/// A frame of these items' pixels, RGBA, row by row from the top.
fn render_items(
    context: &GpuContext,
    compositor: &mut Compositor,
    items: Vec<FrameItemDescriptor>,
) -> Vec<[u8; 4]> {
    let frame = FrameDescriptor {
        width: SIZE,
        height: SIZE,
        clear: CanvasClearDescriptor {
            color: [0.0, 0.0, 0.0, 1.0],
        },
        items,
    };
    let texture = compositor
        .render_frame_to_texture(context, &frame)
        .expect("rendered");
    let buffer = context.device().create_buffer(&wgpu::BufferDescriptor {
        label: Some("test-readback"),
        size: u64::from(4 * SIZE * SIZE),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = context
        .device()
        .create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo {
            texture: &texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::TexelCopyBufferInfo {
            buffer: &buffer,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(4 * SIZE),
                rows_per_image: Some(SIZE),
            },
        },
        wgpu::Extent3d {
            width: SIZE,
            height: SIZE,
            depth_or_array_layers: 1,
        },
    );
    context.queue().submit([encoder.finish()]);
    buffer.slice(..).map_async(wgpu::MapMode::Read, |result| {
        result.expect("mapped");
    });
    context
        .device()
        .poll(wgpu::PollType::wait_indefinitely())
        .expect("finished");
    let bytes = buffer.slice(..).get_mapped_range().to_vec();
    bytes
        .as_chunks::<4>()
        .0
        .iter()
        .map(|&pixel| texel(context, pixel))
        .collect()
}

fn assert_near(pixel: [u8; 4], expected: [u8; 4], what: &str) {
    let near = pixel
        .iter()
        .zip(expected)
        .all(|(&value, expected)| value.abs_diff(expected) <= 2);
    assert!(near, "{what}: {pixel:?}, expected {expected:?}");
}

/// The middle and the four corners.
fn assert_all_near(pixels: &[[u8; 4]], expected: [u8; 4], what: &str) {
    let last = SIZE as usize - 1;
    let middle = SIZE as usize / 2;
    for (x, y) in [(middle, middle), (0, 0), (last, 0), (0, last), (last, last)] {
        assert_near(pixels[y * SIZE as usize + x], expected, what);
    }
}

#[test]
fn a_dissolve_from_one_clip_to_the_other() {
    let Some((context, mut compositor)) = gpu() else {
        return;
    };
    for (progress, expected) in [(0.0, RED), (0.5, [128, 0, 128, 255]), (1.0, BLUE)] {
        let pixels = render(&context, &mut compositor, transition("Fade", progress));
        assert_all_near(&pixels, expected, &format!("at {progress}"));
    }
}

#[test]
fn a_dip_to_a_colour() {
    let Some((context, mut compositor)) = gpu() else {
        return;
    };
    let mut white = transition("FadeColor", 0.5);
    white.params.insert(
        "color".to_owned(),
        TransitionParamValue::Vector(vec![1.0, 1.0, 1.0, 1.0]),
    );
    white
        .params
        .insert("colorPhase".to_owned(), TransitionParamValue::Number(0.5));
    let pixels = render(&context, &mut compositor, white);
    assert_all_near(&pixels, [255, 255, 255, 255], "halfway");
}

#[test]
fn a_wipe_moves_across() {
    let Some((context, mut compositor)) = gpu() else {
        return;
    };
    // WipeRight: the incoming clip comes in from the left.
    let pixels = render(&context, &mut compositor, transition("WipeRight", 0.5));
    let row = SIZE as usize / 2 * SIZE as usize;
    assert_near(pixels[row + 2], BLUE, "left");
    assert_near(pixels[row + SIZE as usize - 3], RED, "right");
}

#[test]
fn a_missing_clip_is_transparent() {
    let Some((context, mut compositor)) = gpu() else {
        return;
    };
    let mut half = transition("Fade", 0.5);
    half.from = None;
    // Half the blue, over the black background.
    let pixels = render(&context, &mut compositor, half);
    assert_all_near(&pixels, [0, 0, 128, 255], "halfway");
}

#[test]
fn an_unknown_transition_dissolves() {
    let Some((context, mut compositor)) = gpu() else {
        return;
    };
    let pixels = render(&context, &mut compositor, transition("NoSuch", 0.5));
    assert_all_near(&pixels, [128, 0, 128, 255], "halfway");
}

#[test]
fn every_transition_starts_on_one_clip_and_ends_on_the_other() {
    let Some((context, mut compositor)) = gpu() else {
        return;
    };
    let usable = gl_transitions::all()
        .iter()
        .filter(|transition| transition.wgsl().is_some() && transition.textures().is_empty());
    let mut wrong = Vec::new();
    for gl_transition in usable {
        for (progress, expected) in [(0.0, RED), (1.0, BLUE)] {
            let pixels = render(
                &context,
                &mut compositor,
                transition(gl_transition.name(), progress),
            );
            let middle = pixels[(SIZE * SIZE / 2 + SIZE / 2) as usize];
            let near = middle
                .iter()
                .zip(expected)
                .all(|(&value, expected)| value.abs_diff(expected) <= 2);
            if !near {
                wrong.push(format!(
                    "{} at {progress}: {middle:?}",
                    gl_transition.name()
                ));
            }
        }
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}

/// The shader as WebGL2 gets it: validated, its uniforms a multiple of 16
/// bytes, and translated to GLSL ES 3.00 by naga, as wgpu's GL backend does.
fn check_for_webgl(transition: &gl_transitions::Transition) -> Result<(), String> {
    use naga::back::glsl;

    let source = padded_wgsl(transition);
    let module =
        naga::front::wgsl::parse_str(&source).map_err(|error| error.emit_to_string(&source))?;
    let info = naga::valid::Validator::new(
        naga::valid::ValidationFlags::all(),
        naga::valid::Capabilities::empty(),
    )
    .validate(&module)
    .map_err(|error| format!("{error:?}"))?;

    let uniforms = module
        .global_variables
        .iter()
        .find(|(_, variable)| variable.space == naga::AddressSpace::Uniform)
        .ok_or("no uniforms")?
        .1;
    let size = module.types[uniforms.ty].inner.size(module.to_ctx());
    if size % 16 != 0 {
        return Err(format!("uniforms of {size} bytes"));
    }

    let options = glsl::Options {
        version: glsl::Version::Embedded {
            version: 300,
            is_webgl: true,
        },
        ..glsl::Options::default()
    };
    let pipeline_options = glsl::PipelineOptions {
        shader_stage: naga::ShaderStage::Fragment,
        entry_point: "main".to_owned(),
        multiview: None,
    };
    let mut output = String::new();
    glsl::Writer::new(
        &mut output,
        &module,
        &info,
        &options,
        &pipeline_options,
        naga::proc::BoundsCheckPolicies::default(),
    )
    .and_then(|mut writer| writer.write())
    .map(|_| ())
    .map_err(|error| error.to_string())
}

#[test]
fn every_transition_translates_for_webgl() {
    let usable = gl_transitions::all()
        .iter()
        .filter(|transition| transition.wgsl().is_some() && transition.textures().is_empty());
    let wrong: Vec<String> = usable
        .filter_map(|transition| {
            check_for_webgl(transition)
                .err()
                .map(|error| format!("{}: {error}", transition.name()))
        })
        .collect();
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}

/// A SIZE x SIZE texture of that id, each pixel's grey from `level(x, y)`.
fn upload_grey(
    context: &GpuContext,
    compositor: &mut Compositor,
    id: &str,
    level: impl Fn(u32, u32) -> u8,
) {
    let texture = context.create_render_texture(SIZE, SIZE, "test-grey");
    let data: Vec<u8> = (0..SIZE)
        .flat_map(|y| (0..SIZE).map(move |x| (x, y)))
        .flat_map(|(x, y)| {
            let grey = level(x, y);
            texel(context, [grey, grey, grey, 255])
        })
        .collect();
    context.queue().write_texture(
        texture.as_image_copy(),
        &data,
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(4 * SIZE),
            rows_per_image: Some(SIZE),
        },
        texture.size(),
    );
    compositor.upsert_texture(id.to_owned(), texture);
}

fn pass(shader: &str, uniforms: &[(&str, f32)]) -> Vec<EffectPassDescriptor> {
    vec![EffectPassDescriptor {
        shader: shader.to_owned(),
        uniforms: uniforms
            .iter()
            .map(|&(name, value)| (name.to_owned(), EffectUniformValueDescriptor::Number(value)))
            .collect(),
    }]
}

/// A layer of that texture, the source filtered as it is before it's placed.
fn filtered_layer(id: &str, filter: Vec<EffectPassDescriptor>) -> FrameItemDescriptor {
    FrameItemDescriptor::Layer(LayerDescriptor {
        source_effect_pass_groups: vec![filter],
        ..layer(id)
    })
}

fn grey_at(pixels: &[[u8; 4]], x: u32, y: u32) -> u8 {
    pixels[(y * SIZE + x) as usize][0]
}

#[test]
fn deinterlacing_fills_the_other_field_from_the_one_kept() {
    let Some((context, mut compositor)) = gpu() else {
        return;
    };
    // Combed: the top field white, the bottom one black.
    upload_grey(&context, &mut compositor, "combed", |_, y| {
        if y % 2 == 0 { 255 } else { 0 }
    });
    for (field, expected) in [(0.0, [255, 255, 255, 255]), (1.0, [0, 0, 0, 255])] {
        let pixels = render_items(
            &context,
            &mut compositor,
            vec![filtered_layer(
                "combed",
                pass("deinterlace", &[("u_field", field)]),
            )],
        );
        // The first and last lines have only one neighbour of the field kept.
        for y in 1..SIZE - 1 {
            for x in 0..SIZE {
                let pixel = pixels[(y * SIZE + x) as usize];
                assert_near(pixel, expected, &format!("field {field} at {x},{y}"));
            }
        }
    }
}

#[test]
fn denoising_smooths_grain_and_keeps_edges() {
    let Some((context, mut compositor)) = gpu() else {
        return;
    };
    let medium = pass("denoise", &[("u_spatial", 1.5), ("u_range", 0.1)]);
    // Grain: a grey checkered six levels either way.
    upload_grey(&context, &mut compositor, "grain", |x, y| {
        if (x + y) % 2 == 0 { 134 } else { 122 }
    });
    let pixels = render_items(
        &context,
        &mut compositor,
        vec![filtered_layer("grain", medium.clone())],
    );
    for (x, y) in [(10, 10), (11, 10), (30, 31)] {
        let grey = grey_at(&pixels, x, y);
        assert!(grey.abs_diff(128) <= 2, "grain at {x},{y}: {grey}");
    }
    // An edge: black then white.
    upload_grey(&context, &mut compositor, "edge", |x, _| {
        if x < SIZE / 2 { 0 } else { 255 }
    });
    let pixels = render_items(
        &context,
        &mut compositor,
        vec![filtered_layer("edge", medium)],
    );
    let (dark, light) = (
        grey_at(&pixels, SIZE / 2 - 1, 20),
        grey_at(&pixels, SIZE / 2, 20),
    );
    assert!(dark <= 3 && light >= 252, "edge: {dark} then {light}");
}

#[test]
fn sharpening_steepens_an_edge_over_the_frame() {
    let Some((context, mut compositor)) = gpu() else {
        return;
    };
    // A soft step from 100 to 156, through 128.
    let middle = SIZE / 2;
    upload_grey(&context, &mut compositor, "soft", |x, _| {
        match x.cmp(&middle) {
            std::cmp::Ordering::Less => 100,
            std::cmp::Ordering::Equal => 128,
            std::cmp::Ordering::Greater => 156,
        }
    });
    let pixels = render_items(
        &context,
        &mut compositor,
        vec![
            FrameItemDescriptor::Layer(layer("soft")),
            FrameItemDescriptor::SceneEffect {
                effect_pass_groups: vec![pass("sharpen", &[("u_amount", 1.0)])],
            },
        ],
    );
    let at = |x| grey_at(&pixels, x, 20);
    assert!(
        at(10).abs_diff(100) <= 1 && at(50).abs_diff(156) <= 1,
        "flat parts changed"
    );
    assert!(
        at(middle - 1) < 95 && at(middle + 1) > 161,
        "{} {} {}",
        at(middle - 1),
        at(middle),
        at(middle + 1)
    );
}
