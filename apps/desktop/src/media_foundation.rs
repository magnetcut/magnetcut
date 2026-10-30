// Media Foundation, Windows's media framework, for the native export there
// (docs/NATIVE.md, phase 5). So far: which encoders the system has.

use windows::Win32::Media::MediaFoundation::{
    IMFActivate, MF_VERSION, MFSTARTUP_FULL, MFStartup, MFT_ENUM_FLAG_ALL,
    MFT_FRIENDLY_NAME_Attribute, MFT_REGISTER_TYPE_INFO, MFTEnumEx,
};
use windows::Win32::System::Com::CoTaskMemFree;
use windows::core::{GUID, PWSTR};

/// Starts Media Foundation for this process: once is enough, more is fine.
pub fn start() -> Result<(), String> {
    unsafe { MFStartup(MF_VERSION, MFSTARTUP_FULL) }.map_err(|error| error.to_string())
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
    .map_err(|error| error.to_string())?;
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
