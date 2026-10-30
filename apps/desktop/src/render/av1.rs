// AV1, which no Mac encodes in hardware, encoded in software by rav1e (BSD-2):
// each frame drawn is converted to YUV and encoded, and its packets go into
// the file as they are, AVAssetWriter passing them through under a format
// description that carries rav1e's av1C record.

use std::ptr::{self, NonNull};

use objc2_core_foundation::{CFMutableDictionary, CFRetained, kCFBooleanTrue};
use objc2_core_media::{
    CMFormatDescription, CMSampleBuffer, CMVideoFormatDescriptionCreate,
    kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms, kCMSampleAttachmentKey_NotSync,
    kCMVideoCodecType_AV1,
};
use objc2_core_video::{
    CVPixelBuffer, CVPixelBufferGetBaseAddress, CVPixelBufferGetBytesPerRow,
    CVPixelBufferLockBaseAddress, CVPixelBufferLockFlags, CVPixelBufferUnlockBaseAddress,
    kCVReturnSuccess,
};
use objc2_foundation::{NSData, NSString};
use rav1e::prelude::*;

use super::av::{any, bridged, cf_dictionary, dictionary, fraction, packet_sample};
use super::encode::FrameRate;

// rav1e's fastest: AV1 in software is slow enough.
const SPEED: u8 = 10;

pub struct Av1Encoder {
    context: Context<u8>,
    format: CFRetained<CMFormatDescription>,
    fps: FrameRate,
    width: usize,
    height: usize,
}

impl Av1Encoder {
    /// At `bitrate` bits a second, or at a constant `quality` from 0 to 1;
    /// a key frame at least each `key_frame_interval` seconds.
    pub fn new(
        (width, height): (u32, u32),
        fps: FrameRate,
        bitrate: u32,
        quality: Option<f32>,
        key_frame_interval: f64,
    ) -> Result<Self, String> {
        let (width, height) = (width as usize, height as usize);
        let rate = f64::from(fps.numerator) / f64::from(fps.denominator);
        let config = EncoderConfig {
            width,
            height,
            time_base: Rational::new(u64::from(fps.denominator), u64::from(fps.numerator)),
            bit_depth: 8,
            chroma_sampling: ChromaSampling::Cs420,
            pixel_range: PixelRange::Limited,
            color_description: Some(ColorDescription {
                color_primaries: ColorPrimaries::BT709,
                transfer_characteristics: TransferCharacteristics::BT709,
                matrix_coefficients: MatrixCoefficients::BT709,
            }),
            max_key_frame_interval: (key_frame_interval * rate).round().max(1.0) as u64,
            // A quantizer of 0 is lossless, 255 the coarsest.
            quantizer: quality.map_or(100, |quality| {
                (255.0 * (1.0 - quality.clamp(0.0, 1.0))).round().max(1.0) as usize
            }),
            bitrate: if quality.is_some() { 0 } else { bitrate as i32 },
            speed_settings: SpeedSettings::from_preset(SPEED),
            // Tiles are encoded side by side, one for each core; and without
            // looking ahead: three and then half again as fast, on an M4.
            tiles: std::thread::available_parallelism().map_or(1, |cores| cores.get()),
            low_latency: true,
            ..Default::default()
        };
        let context = Config::new()
            .with_encoder_config(config)
            .new_context()
            .map_err(|error| format!("Couldn't start the AV1 encoder: {error}"))?;
        let format = format_description(&context.container_sequence_header(), width, height)?;
        Ok(Self {
            context,
            format,
            fps,
            width,
            height,
        })
    }

    /// What its packets are, for the writer to pass them through.
    pub fn format(&self) -> &CMFormatDescription {
        &self.format
    }

    /// Encodes a frame drawn, in BGRA.
    pub fn send(&mut self, frame: &CVPixelBuffer) -> Result<(), String> {
        let mut planes = self.context.new_frame();
        let lock = CVPixelBufferLockFlags::ReadOnly;
        if unsafe { CVPixelBufferLockBaseAddress(frame, lock) } != kCVReturnSuccess {
            return Err("couldn't read a frame".into());
        }
        let row = CVPixelBufferGetBytesPerRow(frame);
        let base = CVPixelBufferGetBaseAddress(frame);
        let result = if base.is_null() {
            Err("a frame has no pixels".to_owned())
        } else {
            // SAFETY: locked, the buffer's memory is its rows, each this long.
            let bgra = unsafe { std::slice::from_raw_parts(base.cast::<u8>(), row * self.height) };
            let (luma, blue, red) = to_yuv(bgra, row, self.width, self.height);
            let chroma_width = self.width.div_ceil(2);
            planes.planes[0].copy_from_raw_u8(&luma, self.width, 1);
            planes.planes[1].copy_from_raw_u8(&blue, chroma_width, 1);
            planes.planes[2].copy_from_raw_u8(&red, chroma_width, 1);
            Ok(())
        };
        unsafe { CVPixelBufferUnlockBaseAddress(frame, lock) };
        result?;
        self.context
            .send_frame(planes)
            .map_err(|error| format!("Couldn't encode a frame: {error}"))
    }

    /// Says there are no more frames: the rest of the packets follow.
    pub fn flush(&mut self) {
        self.context.flush();
    }

    /// The next packet, as a sample buffer: none until there's one ready.
    pub fn receive(&mut self) -> Result<Option<CFRetained<CMSampleBuffer>>, String> {
        loop {
            match self.context.receive_packet() {
                Ok(packet) => return self.sample(&packet).map(Some),
                Err(EncoderStatus::Encoded) => continue,
                Err(EncoderStatus::NeedMoreData | EncoderStatus::LimitReached) => return Ok(None),
                Err(error) => return Err(format!("Couldn't encode a frame: {error}")),
            }
        }
    }

    fn sample(&self, packet: &Packet<u8>) -> Result<CFRetained<CMSampleBuffer>, String> {
        // Each packet shows one frame, in order.
        let (numerator, denominator) = (
            i64::from(self.fps.numerator),
            i64::from(self.fps.denominator),
        );
        let sample = packet_sample(
            &packet.data,
            &self.format,
            fraction(packet.input_frameno as i64 * denominator, numerator as i32),
            fraction(denominator, numerator as i32),
        )?;
        if packet.frame_type != FrameType::KEY {
            mark_not_sync(&sample);
        }
        Ok(sample)
    }
}

/// Marks a sample as not one to start decoding from: all but key frames.
fn mark_not_sync(sample: &CMSampleBuffer) {
    let Some(attachments) = (unsafe { sample.sample_attachments_array(true) }) else {
        return;
    };
    let first = unsafe { attachments.value_at_index(0) }.cast::<CFMutableDictionary>();
    if let (Some(first), Some(yes)) = (unsafe { first.as_ref() }, unsafe { kCFBooleanTrue }) {
        unsafe {
            CFMutableDictionary::set_value(
                Some(first),
                (kCMSampleAttachmentKey_NotSync as *const objc2_core_foundation::CFString).cast(),
                (yes as *const objc2_core_foundation::CFBoolean).cast(),
            )
        };
    }
}

/// The format of AV1 packets this size, with their av1C record.
fn format_description(
    av1c: &[u8],
    width: usize,
    height: usize,
) -> Result<CFRetained<CMFormatDescription>, String> {
    let record = NSData::with_bytes(av1c);
    let name = NSString::from_str("av1C");
    let atoms = dictionary(&[(&*name, any(&record))]);
    let extensions = dictionary(&[(
        bridged(unsafe { kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms }),
        any(&atoms),
    )]);
    let mut format = ptr::null();
    let status = unsafe {
        CMVideoFormatDescriptionCreate(
            None,
            kCMVideoCodecType_AV1,
            width as i32,
            height as i32,
            Some(cf_dictionary(&extensions)),
            NonNull::from(&mut format),
        )
    };
    let format = NonNull::new(format.cast_mut())
        .filter(|_| status == 0)
        .ok_or("Couldn't describe the AV1 packets")?;
    // SAFETY: created, so ours to release.
    Ok(unsafe { CFRetained::from_raw(format.cast()) })
}

/// BGRA as BT.709 YUV in video range: luma, then blue and red difference at
/// half the size each way, each chroma sample the average of four pixels.
fn to_yuv(bgra: &[u8], row: usize, width: usize, height: usize) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    let pixel = |x: usize, y: usize| {
        let at = y.min(height - 1) * row + x.min(width - 1) * 4;
        [
            i32::from(bgra[at + 2]),
            i32::from(bgra[at + 1]),
            i32::from(bgra[at]),
        ]
    };
    let mut luma = vec![0u8; width * height];
    for y in 0..height {
        for x in 0..width {
            let [r, g, b] = pixel(x, y);
            luma[y * width + x] = (((47 * r + 157 * g + 16 * b + 128) >> 8) + 16) as u8;
        }
    }
    let (chroma_width, chroma_height) = (width.div_ceil(2), height.div_ceil(2));
    let mut blue = vec![0u8; chroma_width * chroma_height];
    let mut red = vec![0u8; chroma_width * chroma_height];
    for y in 0..chroma_height {
        for x in 0..chroma_width {
            let mut sum = [0; 3];
            for (dx, dy) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
                let color = pixel(2 * x + dx, 2 * y + dy);
                for channel in 0..3 {
                    sum[channel] += color[channel];
                }
            }
            let [r, g, b] = sum.map(|total| (total + 2) / 4);
            blue[y * chroma_width + x] = (((-26 * r - 87 * g + 112 * b + 128) >> 8) + 128) as u8;
            red[y * chroma_width + x] = (((112 * r - 102 * g - 10 * b + 128) >> 8) + 128) as u8;
        }
    }
    (luma, blue, red)
}

#[cfg(test)]
mod tests {
    #[test]
    fn grey_stays_grey_and_colours_land_where_bt709_puts_them() {
        // 2x2 pixels, BGRA: white, black, pure red, mid grey.
        let bgra = [
            255, 255, 255, 255, 0, 0, 0, 255, //
            0, 0, 255, 255, 128, 128, 128, 255,
        ];
        let (luma, blue, red) = super::to_yuv(&bgra, 8, 2, 2);
        assert_eq!(luma, [235, 16, 63, 126]);
        // The average of the four, in the chroma: red pushes Cr up, Cb down.
        assert!(red[0] > 128 && blue[0] < 128, "{blue:?} {red:?}");
    }
}
