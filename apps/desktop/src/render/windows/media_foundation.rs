// Media Foundation, Windows's media framework, as the native export there
// uses it (docs/NATIVE.md, phase 5): starting it, media types, samples, and
// which encoders the system has.

use std::path::Path;

use windows::Win32::Media::MediaFoundation::{
    IMFActivate, IMFAttributes, IMFMediaBuffer, IMFMediaType, IMFSample,
    MF_MT_AUDIO_AVG_BYTES_PER_SECOND, MF_MT_AUDIO_BITS_PER_SAMPLE, MF_MT_AUDIO_BLOCK_ALIGNMENT,
    MF_MT_AUDIO_NUM_CHANNELS, MF_MT_AUDIO_SAMPLES_PER_SECOND, MF_MT_AVG_BITRATE, MF_MT_FRAME_RATE,
    MF_MT_FRAME_SIZE, MF_MT_INTERLACE_MODE, MF_MT_MAJOR_TYPE, MF_MT_PIXEL_ASPECT_RATIO,
    MF_MT_SUBTYPE, MF_MT_TRANSFER_FUNCTION, MF_MT_VIDEO_NOMINAL_RANGE, MF_MT_VIDEO_PRIMARIES,
    MF_MT_YUV_MATRIX, MF_VERSION, MFCreateAttributes, MFCreateMediaType, MFCreateMemoryBuffer,
    MFCreateSample, MFMediaType_Audio, MFMediaType_Video, MFNominalRange, MFSTARTUP_FULL,
    MFStartup, MFT_ENUM_FLAG_ALL, MFT_FRIENDLY_NAME_Attribute, MFT_REGISTER_TYPE_INFO, MFTEnumEx,
    MFVideoInterlace_Progressive, MFVideoPrimaries_BT709, MFVideoTransFunc_709,
    MFVideoTransferMatrix_BT709,
};
use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx, CoTaskMemFree};
use windows::core::{GUID, PWSTR};

// Media Foundation counts time in hundreds of nanoseconds.
pub const TICKS_PER_SECOND: i64 = 10_000_000;

pub fn text(error: windows::core::Error) -> String {
    error.to_string()
}

/// Starts COM on this thread and Media Foundation for the process: once is
/// enough, more is fine.
pub fn start() -> Result<(), String> {
    // Already started, perhaps otherwise: Media Foundation runs either way.
    let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    unsafe { MFStartup(MF_VERSION, MFSTARTUP_FULL) }.map_err(text)
}

/// A path as Windows takes it: UTF-16, ending in a nul.
pub fn wide(path: &Path) -> Result<Vec<u16>, String> {
    let path = path.to_str().ok_or("not a UTF-8 path")?;
    Ok(path.encode_utf16().chain([0]).collect())
}

/// Attributes of these numbers, and these GUIDs.
pub fn attributes(
    numbers: &[(GUID, u32)],
    guids: &[(GUID, GUID)],
) -> Result<IMFAttributes, String> {
    let mut attributes = None;
    let count = (numbers.len() + guids.len()) as u32;
    unsafe { MFCreateAttributes(&mut attributes, count) }.map_err(text)?;
    let attributes = attributes.ok_or("no attributes")?;
    for (key, value) in numbers {
        unsafe { attributes.SetUINT32(key, *value) }.map_err(text)?;
    }
    for (key, value) in guids {
        unsafe { attributes.SetGUID(key, value) }.map_err(text)?;
    }
    Ok(attributes)
}

/// Two numbers as one, as Media Foundation packs a size or a rate.
pub fn pair(high: u32, low: u32) -> u64 {
    (u64::from(high) << 32) | u64::from(low)
}

/// A size or a rate, unpacked.
pub fn unpair(value: u64) -> (u32, u32) {
    ((value >> 32) as u32, value as u32)
}

/// Pictures of this size and rate, in `subtype`, at `bitrate` if encoded.
pub fn video_type(
    subtype: GUID,
    (width, height): (u32, u32),
    (numerator, denominator): (u32, u32),
    bitrate: Option<u32>,
) -> Result<IMFMediaType, String> {
    let media_type = unsafe { MFCreateMediaType() }.map_err(text)?;
    unsafe {
        media_type
            .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
            .map_err(text)?;
        media_type.SetGUID(&MF_MT_SUBTYPE, &subtype).map_err(text)?;
        media_type
            .SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)
            .map_err(text)?;
        media_type
            .SetUINT64(&MF_MT_FRAME_SIZE, pair(width, height))
            .map_err(text)?;
        media_type
            .SetUINT64(&MF_MT_FRAME_RATE, pair(numerator, denominator))
            .map_err(text)?;
        media_type
            .SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pair(1, 1))
            .map_err(text)?;
        if let Some(bitrate) = bitrate {
            media_type
                .SetUINT32(&MF_MT_AVG_BITRATE, bitrate)
                .map_err(text)?;
        }
    }
    Ok(media_type)
}

/// HD's colours (BT.709), which the compositor works in, at that range: so
/// that nothing between the editor's pictures and the file converts them.
/// RGB left unsaid is taken as sRGB's curve, and converted to BT.709's.
pub fn hd_colors(media_type: &IMFMediaType, range: MFNominalRange) -> Result<(), String> {
    unsafe {
        media_type
            .SetUINT32(&MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709.0 as u32)
            .map_err(text)?;
        media_type
            .SetUINT32(&MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709.0 as u32)
            .map_err(text)?;
        media_type
            .SetUINT32(&MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709.0 as u32)
            .map_err(text)?;
        media_type
            .SetUINT32(&MF_MT_VIDEO_NOMINAL_RANGE, range.0 as u32)
            .map_err(text)
    }
}

/// Sound in `subtype`: AAC at `bitrate`, else 16-bit samples.
pub fn audio_type(
    subtype: GUID,
    channels: u32,
    sample_rate: u32,
    bitrate: Option<u32>,
) -> Result<IMFMediaType, String> {
    let media_type = unsafe { MFCreateMediaType() }.map_err(text)?;
    unsafe {
        media_type
            .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)
            .map_err(text)?;
        media_type.SetGUID(&MF_MT_SUBTYPE, &subtype).map_err(text)?;
        media_type
            .SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)
            .map_err(text)?;
        media_type
            .SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, sample_rate)
            .map_err(text)?;
        media_type
            .SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, channels)
            .map_err(text)?;
        match bitrate {
            Some(bitrate) => media_type
                .SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, bitrate / 8)
                .map_err(text)?,
            None => {
                media_type
                    .SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, channels * 2)
                    .map_err(text)?;
                media_type
                    .SetUINT32(
                        &MF_MT_AUDIO_AVG_BYTES_PER_SECOND,
                        sample_rate * channels * 2,
                    )
                    .map_err(text)?;
            }
        }
    }
    Ok(media_type)
}

/// A buffer of `length` bytes, filled by `fill`.
pub fn buffer(length: usize, fill: impl FnOnce(&mut [u8])) -> Result<IMFMediaBuffer, String> {
    let buffer = unsafe { MFCreateMemoryBuffer(length as u32) }.map_err(text)?;
    let mut data = std::ptr::null_mut();
    unsafe { buffer.Lock(&mut data, None, None) }.map_err(text)?;
    // SAFETY: locked, the buffer holds `length` bytes.
    fill(unsafe { std::slice::from_raw_parts_mut(data, length) });
    unsafe {
        buffer.Unlock().map_err(text)?;
        buffer.SetCurrentLength(length as u32).map_err(text)?;
    }
    Ok(buffer)
}

/// A sample of that buffer, at `time` for `duration`, in hundreds of
/// nanoseconds.
pub fn sample(buffer: &IMFMediaBuffer, time: i64, duration: i64) -> Result<IMFSample, String> {
    let sample = unsafe { MFCreateSample() }.map_err(text)?;
    unsafe {
        sample.AddBuffer(buffer).map_err(text)?;
        sample.SetSampleTime(time).map_err(text)?;
        sample.SetSampleDuration(duration).map_err(text)?;
    }
    Ok(sample)
}

/// The names of the system's encoders of `category` (video or audio) that
/// make `subtype` (H.264, HEVC, AAC…), hardware ones first.
pub fn encoders(category: GUID, major: GUID, subtype: GUID) -> Result<Vec<String>, String> {
    start()?;
    let output = MFT_REGISTER_TYPE_INFO {
        guidMajorType: major,
        guidSubtype: subtype,
    };
    let mut activates: *mut Option<IMFActivate> = std::ptr::null_mut();
    let mut count = 0u32;
    unsafe {
        MFTEnumEx(
            category,
            MFT_ENUM_FLAG_ALL,
            None,
            Some(std::ptr::from_ref(&output)),
            &mut activates,
            &mut count,
        )
    }
    .map_err(text)?;
    let mut names = Vec::new();
    if activates.is_null() {
        return Ok(names);
    }
    // SAFETY: MFTEnumEx gives `count` of them, for us to release and free.
    let list = unsafe { std::slice::from_raw_parts_mut(activates, count as usize) };
    for activate in list.iter_mut() {
        if let Some(activate) = activate.take() {
            let mut name = PWSTR::null();
            let mut length = 0u32;
            if unsafe {
                activate.GetAllocatedString(&MFT_FRIENDLY_NAME_Attribute, &mut name, &mut length)
            }
            .is_ok()
            {
                names.push(unsafe { name.to_string() }.unwrap_or_default());
                unsafe { CoTaskMemFree(Some(name.0.cast_const().cast())) };
            }
        }
    }
    unsafe { CoTaskMemFree(Some(activates.cast_const().cast())) };
    Ok(names)
}

#[cfg(test)]
mod tests {
    use windows::Win32::Media::MediaFoundation::{
        MFAudioFormat_AAC, MFMediaType_Audio, MFMediaType_Video, MFT_CATEGORY_AUDIO_ENCODER,
        MFT_CATEGORY_VIDEO_ENCODER, MFVideoFormat_H264, MFVideoFormat_HEVC,
    };

    /// What this system has to encode with: printed, for the CI runners'.
    #[test]
    fn lists_the_encoders() {
        for (name, category, major, subtype) in [
            (
                "H.264",
                MFT_CATEGORY_VIDEO_ENCODER,
                MFMediaType_Video,
                MFVideoFormat_H264,
            ),
            (
                "HEVC",
                MFT_CATEGORY_VIDEO_ENCODER,
                MFMediaType_Video,
                MFVideoFormat_HEVC,
            ),
            (
                "AAC",
                MFT_CATEGORY_AUDIO_ENCODER,
                MFMediaType_Audio,
                MFAudioFormat_AAC,
            ),
        ] {
            match super::encoders(category, major, subtype) {
                Ok(encoders) => eprintln!("{name} encoders: {encoders:?}"),
                Err(error) => eprintln!("{name} encoders: none, {error}"),
            }
        }
    }
}
