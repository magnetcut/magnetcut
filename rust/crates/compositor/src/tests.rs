//! Frames drawn by the compositor on this machine's GPU, checked pixel by
//! pixel. Without a GPU they pass, saying so.

use std::collections::HashMap;

use gpu::{GpuContext, wgpu};

use crate::{
    BlendMode, CanvasClearDescriptor, Compositor, FrameDescriptor, FrameItemDescriptor,
    LayerDescriptor, QuadTransformDescriptor, TransitionDescriptor, TransitionParamValue,
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
    let frame = FrameDescriptor {
        width: SIZE,
        height: SIZE,
        clear: CanvasClearDescriptor {
            color: [0.0, 0.0, 0.0, 1.0],
        },
        items: vec![FrameItemDescriptor::Transition(transition)],
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
        .chunks_exact(4)
        .map(|pixel| texel(context, [pixel[0], pixel[1], pixel[2], pixel[3]]))
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
