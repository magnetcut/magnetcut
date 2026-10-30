// What the native export says to AVFoundation in: settings dictionaries, its
// weakly linked constants, file URLs and times.

use std::path::Path;
use std::ptr::{self, NonNull};

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2_core_foundation::{CFDictionary, CFRetained, CFString};
use objc2_core_media::{
    CMBlockBuffer, CMFormatDescription, CMSampleBuffer, CMSampleTimingInfo, CMTime,
    kCMBlockBufferAssureMemoryNowFlag, kCMTimeInvalid,
};
use objc2_foundation::{NSDictionary, NSError, NSString, NSURL};

/// A settings dictionary, from its keys and values.
pub fn dictionary(
    entries: &[(&NSString, &AnyObject)],
) -> Retained<NSDictionary<NSString, AnyObject>> {
    let (keys, values): (Vec<&NSString>, Vec<&AnyObject>) = entries.iter().copied().unzip();
    NSDictionary::from_slices(&keys, &values)
}

/// Any object, as a dictionary's value.
pub fn any(object: &AnyObject) -> &AnyObject {
    object
}

/// One of AVFoundation's constants, which are linked weakly: missing on a
/// system older than the constant.
pub fn constant<T: ?Sized>(value: Option<&'static T>, name: &str) -> Result<&'static T, String> {
    value.ok_or_else(|| format!("{name} isn't on this system"))
}

/// An AVFoundation constant by name, or the error that the system lacks it.
macro_rules! av {
    ($name:ident) => {{
        #[allow(unused_unsafe)]
        let value = unsafe { $name };
        $crate::render::av::constant(value, stringify!($name))?
    }};
}
pub(crate) use av;

/// A Core Foundation string, as the Foundation one it is too.
pub fn bridged(string: &CFString) -> &NSString {
    // SAFETY: CFString and NSString are toll-free bridged: the same object.
    unsafe { &*(string as *const CFString).cast::<NSString>() }
}

/// A Foundation dictionary, as the Core Foundation one it is too.
pub fn cf_dictionary<K: ?Sized, V: ?Sized>(dictionary: &NSDictionary<K, V>) -> &CFDictionary {
    // SAFETY: NSDictionary and CFDictionary are toll-free bridged.
    unsafe { &*(dictionary as *const NSDictionary<K, V>).cast::<CFDictionary>() }
}

pub fn file_url(path: &Path) -> Result<Retained<NSURL>, String> {
    let path = path.to_str().ok_or("not a UTF-8 path")?;
    Ok(NSURL::fileURLWithPath(&NSString::from_str(path)))
}

/// What went wrong, as AVFoundation says it.
pub fn describe(error: Option<Retained<NSError>>, doing: &str) -> String {
    match error {
        Some(error) => format!("{doing}: {}", error.localizedDescription()),
        None => doing.to_owned(),
    }
}

/// A time in seconds, exactly enough for any frame rate's frames.
pub fn seconds(value: f64) -> CMTime {
    // SAFETY: CMTimeMakeWithSeconds has no preconditions.
    unsafe { CMTime::with_seconds(value, TIMESCALE) }
}

/// A time as a fraction: `value / timescale` seconds.
pub fn fraction(value: i64, timescale: i32) -> CMTime {
    // SAFETY: CMTimeMake has no preconditions.
    unsafe { CMTime::new(value, timescale) }
}

pub fn to_seconds(time: CMTime) -> f64 {
    // SAFETY: CMTimeGetSeconds has no preconditions.
    unsafe { time.seconds() }
}

// Divides evenly by the common frame rates' frame durations, NTSC's included.
const TIMESCALE: i32 = 120_000;

/// One sample of encoded data, in the format given, at `start` for `duration`.
pub fn packet_sample(
    data: &[u8],
    format: &CMFormatDescription,
    start: CMTime,
    duration: CMTime,
) -> Result<CFRetained<CMSampleBuffer>, String> {
    let mut block: *mut CMBlockBuffer = ptr::null_mut();
    let status = unsafe {
        CMBlockBuffer::create_with_memory_block(
            None,
            ptr::null_mut(),
            data.len().max(1),
            None,
            ptr::null(),
            0,
            data.len().max(1),
            kCMBlockBufferAssureMemoryNowFlag,
            NonNull::from(&mut block),
        )
    };
    let block = NonNull::new(block)
        .filter(|_| status == 0)
        .ok_or("Couldn't hold a sample")?;
    // SAFETY: created, so ours to release.
    let block = unsafe { CFRetained::from_raw(block) };
    if !data.is_empty() {
        let status = unsafe {
            CMBlockBuffer::replace_data_bytes(NonNull::from(data).cast(), &block, 0, data.len())
        };
        if status != 0 {
            return Err("Couldn't hold a sample".into());
        }
    }
    let timing = CMSampleTimingInfo {
        duration,
        presentationTimeStamp: start,
        decodeTimeStamp: unsafe { kCMTimeInvalid },
    };
    let size = data.len();
    let mut sample: *mut CMSampleBuffer = ptr::null_mut();
    let status = unsafe {
        CMSampleBuffer::create_ready(
            None,
            Some(&block),
            Some(format),
            1,
            1,
            &timing,
            1,
            &size,
            NonNull::from(&mut sample),
        )
    };
    let sample = NonNull::new(sample)
        .filter(|_| status == 0)
        .ok_or("Couldn't hold a sample")?;
    // SAFETY: created, so ours to release.
    Ok(unsafe { CFRetained::from_raw(sample) })
}
