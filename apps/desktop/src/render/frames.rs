// The export's frames on the GPU: the sources' pictures uploaded, each frame
// composited by the editor's own compositor (rust/crates/compositor), cut and
// scaled to the size encoded, and read back into the encoder's buffer.

use std::collections::HashMap;
use std::sync::mpsc;

use compositor::{Compositor, FrameDescriptor};
use gpu::{GpuContext, wgpu};
use serde::Deserialize;

use super::turn::Turner;

/// What's cut from the picture's edges, in the project's pixels.
#[derive(Debug, Clone, Copy, Default, Deserialize)]
pub struct Crop {
    pub top: u32,
    pub bottom: u32,
    pub left: u32,
    pub right: u32,
}

pub struct FrameRenderer {
    context: GpuContext,
    compositor: Compositor,
    turner: Turner,
    /// Turned sources' pictures as they're stored, by texture id.
    stored: HashMap<String, wgpu::Texture>,
    /// The cut picture, when it's also scaled.
    cropped: Option<wgpu::Texture>,
    /// The sizes it's halved through on the way down, then the size encoded.
    steps: Vec<wgpu::Texture>,
    crop: Crop,
    /// The cut picture's size, and the size encoded.
    cropped_size: (u32, u32),
    output_size: (u32, u32),
    readback: wgpu::Buffer,
    padded_row: u32,
}

/// A picture to upload: its pixels, in rows that may be padded.
pub struct Pixels<'a> {
    pub width: u32,
    pub height: u32,
    pub bytes_per_row: u32,
    /// In BGRA order, straight alpha.
    pub data: &'a [u8],
}

/// A picture as the system's decoder gives it.
pub trait Picture {
    /// Hands its pixels to `read`, while they can be read.
    fn read<T>(&self, read: impl FnOnce(&Pixels<'_>) -> T) -> Result<T, String>;
}

/// A buffer the system's encoder takes a frame in, of the size encoded.
pub trait FrameBuffer {
    /// Puts a frame in it: BGRA, its rows `row` bytes apart in `data`.
    fn write(&self, data: &[u8], row: usize) -> Result<(), String>;
}

impl FrameRenderer {
    pub fn new(
        context: GpuContext,
        project_size: (u32, u32),
        crop: Crop,
        output_size: (u32, u32),
    ) -> Result<Self, String> {
        let (project_width, project_height) = project_size;
        let cropped_size = (
            project_width
                .checked_sub(crop.left + crop.right)
                .filter(|&width| width > 0)
                .ok_or("the crop leaves no picture")?,
            project_height
                .checked_sub(crop.top + crop.bottom)
                .filter(|&height| height > 0)
                .ok_or("the crop leaves no picture")?,
        );
        let is_scaled = cropped_size != output_size;
        let cropped = is_scaled.then(|| {
            context.create_render_texture(cropped_size.0, cropped_size.1, "export-cropped")
        });
        let steps = if is_scaled {
            halving_steps(cropped_size, output_size)
                .into_iter()
                .map(|(width, height)| {
                    context.create_render_texture(width, height, "export-scaled")
                })
                .collect()
        } else {
            Vec::new()
        };
        // Rows copied out of a texture are aligned to 256 bytes.
        let padded_row = (output_size.0 * 4).next_multiple_of(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT);
        let readback = context.device().create_buffer(&wgpu::BufferDescriptor {
            label: Some("export-readback"),
            size: u64::from(padded_row) * u64::from(output_size.1),
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let compositor = Compositor::new(&context);
        let turner = Turner::new(&context);
        Ok(Self {
            context,
            compositor,
            turner,
            stored: HashMap::new(),
            cropped,
            steps,
            crop,
            cropped_size,
            output_size,
            readback,
            padded_row,
        })
    }

    /// Puts a picture in the texture of that id.
    pub fn upload(&mut self, id: &str, pixels: Pixels<'_>) {
        let texture = self.texture(id, (pixels.width, pixels.height));
        self.write(&texture, &pixels);
    }

    /// The texture of that id: the one there if it's this size, otherwise a
    /// new one.
    fn texture(&mut self, id: &str, size: (u32, u32)) -> wgpu::Texture {
        match self.compositor.texture(id) {
            Some(texture) if (texture.width(), texture.height()) == size => texture.clone(),
            _ => {
                let texture = self
                    .context
                    .create_render_texture(size.0, size.1, "export-source");
                self.compositor
                    .upsert_texture(id.to_owned(), texture.clone());
                texture
            }
        }
    }

    fn write(&self, texture: &wgpu::Texture, pixels: &Pixels<'_>) {
        self.context.queue().write_texture(
            wgpu::TexelCopyTextureInfo {
                texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            pixels.data,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(pixels.bytes_per_row),
                rows_per_image: Some(pixels.height),
            },
            extent((pixels.width, pixels.height)),
        );
    }

    /// Puts a decoded picture in the texture of that id, turned clockwise by
    /// `rotation` degrees as the source says it's shown.
    pub fn upload_picture(
        &mut self,
        id: &str,
        picture: &impl Picture,
        rotation: u32,
    ) -> Result<(), String> {
        picture.read(|pixels| self.upload_turned(id, pixels, rotation))?
    }

    fn upload_turned(
        &mut self,
        id: &str,
        pixels: &Pixels<'_>,
        rotation: u32,
    ) -> Result<(), String> {
        let size = (pixels.width, pixels.height);
        if rotation == 0 {
            let texture = self.texture(id, size);
            self.write(&texture, pixels);
            return Ok(());
        }
        let stored = match self.stored.get(id) {
            Some(texture) if (texture.width(), texture.height()) == size => texture.clone(),
            _ => {
                let texture = self
                    .context
                    .create_render_texture(size.0, size.1, "export-stored");
                self.stored.insert(id.to_owned(), texture.clone());
                texture
            }
        };
        self.write(&stored, pixels);
        let shown = self.texture(id, Turner::shown_size(size, rotation));
        self.turner.turn(&self.context, &stored, &shown, rotation)
    }

    pub fn release(&mut self, id: &str) {
        self.stored.remove(id);
        self.compositor.release_texture(id);
    }

    pub fn has_texture(&self, id: &str) -> bool {
        self.compositor.texture(id).is_some()
    }

    /// Composites a frame and puts it, cut and scaled, in `target`.
    pub fn render(
        &mut self,
        frame: &FrameDescriptor,
        target: &impl FrameBuffer,
    ) -> Result<(), String> {
        let scene = self
            .compositor
            .render_frame_to_texture(&self.context, frame)
            .map_err(|error| error.to_string())?;
        let device = self.context.device();
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("export-output"),
        });
        // The picture encoded, and where in it the frame starts.
        let (source, origin) = match &self.cropped {
            None => (scene, (self.crop.left, self.crop.top)),
            Some(cropped) => {
                encoder.copy_texture_to_texture(
                    wgpu::TexelCopyTextureInfo {
                        texture: &scene,
                        mip_level: 0,
                        origin: wgpu::Origin3d {
                            x: self.crop.left,
                            y: self.crop.top,
                            z: 0,
                        },
                        aspect: wgpu::TextureAspect::All,
                    },
                    cropped.as_image_copy(),
                    extent(self.cropped_size),
                );
                let mut source = cropped;
                for step in &self.steps {
                    let view = step.create_view(&wgpu::TextureViewDescriptor::default());
                    self.context.encode_texture_blit_to_view(
                        &mut encoder,
                        source,
                        &view,
                        "export-scale",
                    );
                    source = step;
                }
                (source.clone(), (0, 0))
            }
        };
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &source,
                mip_level: 0,
                origin: wgpu::Origin3d {
                    x: origin.0,
                    y: origin.1,
                    z: 0,
                },
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &self.readback,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(self.padded_row),
                    rows_per_image: Some(self.output_size.1),
                },
            },
            extent(self.output_size),
        );
        self.context.queue().submit([encoder.finish()]);

        let slice = self.readback.slice(..);
        let (sender, receiver) = mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |result| {
            let _ = sender.send(result);
        });
        device
            .poll(wgpu::PollType::wait_indefinitely())
            .map_err(|error| error.to_string())?;
        receiver
            .recv()
            .map_err(|error| error.to_string())?
            .map_err(|error| error.to_string())?;
        let copied = target.write(&slice.get_mapped_range(), self.padded_row as usize);
        self.readback.unmap();
        copied
    }
}

fn extent((width, height): (u32, u32)) -> wgpu::Extent3d {
    wgpu::Extent3d {
        width,
        height,
        depth_or_array_layers: 1,
    }
}

/// The sizes a picture goes through, halving while it's at least twice the
/// size wanted, then that size: each step's filter sees every pixel.
fn halving_steps(from: (u32, u32), to: (u32, u32)) -> Vec<(u32, u32)> {
    let mut steps = Vec::new();
    let mut size = from;
    while size.0 >= to.0 * 2 && size.1 >= to.1 * 2 {
        size = (size.0 / 2, size.1 / 2);
        steps.push(size);
    }
    if size != to {
        steps.push(to);
    }
    steps
}

/// A picture of that size, all clear: for a source with no frames.
pub fn clear_pixels(width: u32, height: u32) -> Vec<u8> {
    vec![0; (width * height * 4) as usize]
}

/// RGBA pixels, as the editor draws them, in BGRA order.
pub fn rgba_to_bgra(pixels: &mut [u8]) {
    for pixel in pixels.as_chunks_mut::<4>().0 {
        pixel.swap(0, 2);
    }
}

/// The textures uploaded, by id: which source picture each has now.
#[derive(Default)]
pub struct UploadedFrames(HashMap<String, (usize, f64)>);

impl UploadedFrames {
    /// Whether the texture already has this source's frame of that time.
    pub fn has(&self, id: &str, source: usize, time: f64) -> bool {
        self.0.get(id) == Some(&(source, time))
    }

    pub fn set(&mut self, id: &str, source: usize, time: f64) {
        self.0.insert(id.to_owned(), (source, time));
    }

    pub fn remove(&mut self, id: &str) {
        self.0.remove(id);
    }
}

#[cfg(test)]
mod tests {
    use super::halving_steps;

    #[test]
    fn halves_while_twice_the_size_then_scales_to_it() {
        assert_eq!(
            halving_steps((3840, 2160), (1280, 720)),
            [(1920, 1080), (1280, 720)]
        );
        assert_eq!(halving_steps((3840, 2160), (1920, 1080)), [(1920, 1080)]);
        assert_eq!(halving_steps((1920, 1080), (1280, 720)), [(1280, 720)]);
        assert_eq!(halving_steps((1280, 720), (1920, 1080)), [(1920, 1080)]);
    }
}
