// Core Video's pixel buffer as the export's pictures (`frames.rs`): what
// AVFoundation decodes into, and what its encoders take.

use objc2_core_foundation::CFRetained;
use objc2_core_video::{
    CVPixelBuffer, CVPixelBufferGetBaseAddress, CVPixelBufferGetBytesPerRow,
    CVPixelBufferGetHeight, CVPixelBufferGetWidth, CVPixelBufferLockBaseAddress,
    CVPixelBufferLockFlags, CVPixelBufferUnlockBaseAddress, kCVReturnSuccess,
};

use super::frames::{FrameBuffer, Picture, Pixels};

impl Picture for CVPixelBuffer {
    fn read<T>(&self, read: impl FnOnce(&Pixels<'_>) -> T) -> Result<T, String> {
        let lock = CVPixelBufferLockFlags::ReadOnly;
        if unsafe { CVPixelBufferLockBaseAddress(self, lock) } != kCVReturnSuccess {
            return Err("couldn't read a decoded picture".into());
        }
        let height = CVPixelBufferGetHeight(self);
        let bytes_per_row = CVPixelBufferGetBytesPerRow(self);
        let base = CVPixelBufferGetBaseAddress(self);
        let result = if base.is_null() {
            Err("a decoded picture has no pixels".into())
        } else {
            // SAFETY: locked, the buffer's memory is its rows, each this long.
            let data =
                unsafe { std::slice::from_raw_parts(base.cast::<u8>(), bytes_per_row * height) };
            Ok(read(&Pixels {
                width: CVPixelBufferGetWidth(self) as u32,
                height: height as u32,
                bytes_per_row: bytes_per_row as u32,
                data,
            }))
        };
        unsafe { CVPixelBufferUnlockBaseAddress(self, lock) };
        result
    }
}

impl FrameBuffer for CVPixelBuffer {
    fn write(&self, data: &[u8], row: usize) -> Result<(), String> {
        let lock = CVPixelBufferLockFlags(0);
        if unsafe { CVPixelBufferLockBaseAddress(self, lock) } != kCVReturnSuccess {
            return Err("couldn't write a frame for the encoder".into());
        }
        let width = CVPixelBufferGetWidth(self);
        let height = CVPixelBufferGetHeight(self);
        let bytes_per_row = CVPixelBufferGetBytesPerRow(self);
        let base = CVPixelBufferGetBaseAddress(self).cast::<u8>();
        let length = width * 4;
        let fits = !base.is_null() && data.len() >= row * (height - 1) + length;
        if fits {
            for y in 0..height {
                let source = &data[y * row..y * row + length];
                // SAFETY: locked, the buffer's rows are `bytes_per_row` apart,
                // each at least `width` BGRA pixels.
                unsafe {
                    std::ptr::copy_nonoverlapping(
                        source.as_ptr(),
                        base.add(y * bytes_per_row),
                        length,
                    );
                }
            }
        }
        unsafe { CVPixelBufferUnlockBaseAddress(self, lock) };
        if !fits {
            return Err("the encoder's buffer isn't the frame's size".into());
        }
        Ok(())
    }
}

impl FrameBuffer for CFRetained<CVPixelBuffer> {
    fn write(&self, data: &[u8], row: usize) -> Result<(), String> {
        (**self).write(data, row)
    }
}
