// GStreamer, the system's media framework on Linux (WebKitGTK plays video
// with it too), as the native export there uses it (docs/NATIVE.md, phase
// 5): starting it, pipelines, and which elements the system has.

use gstreamer as gst;
use gstreamer::prelude::*;

pub fn start() -> Result<(), String> {
    gst::init().map_err(|error| error.to_string())
}

/// The first of these elements the system has: hardware ones come first.
pub fn first_element(names: &[&'static str]) -> Option<&'static str> {
    if start().is_err() {
        return None;
    }
    names
        .iter()
        .copied()
        .find(|name| gst::ElementFactory::find(name).is_some())
}

/// A pipeline, from its description.
pub fn launch(description: &str) -> Result<gst::Pipeline, String> {
    start()?;
    gst::parse_launch(description)
        .map_err(|error| error.to_string())?
        .downcast::<gst::Pipeline>()
        .map_err(|_| "not a pipeline".to_owned())
}

/// The pipeline's element of that name, as what it is.
pub fn by_name<T: IsA<gst::Element>>(pipeline: &gst::Pipeline, name: &str) -> Result<T, String> {
    pipeline
        .by_name(name)
        .ok_or_else(|| format!("no {name} in the pipeline"))?
        .downcast::<T>()
        .map_err(|_| format!("{name} isn't what it should be"))
}

/// Why the pipeline stopped, if it has: its first error.
pub fn failure(pipeline: &gst::Pipeline) -> Option<String> {
    let bus = pipeline.bus()?;
    while let Some(message) = bus.pop_filtered(&[gst::MessageType::Error]) {
        if let gst::MessageView::Error(error) = message.view() {
            return Some(error.error().to_string());
        }
    }
    None
}

/// Puts the pipeline in that state, waiting till it's there.
pub fn set_state(pipeline: &gst::Pipeline, state: gst::State) -> Result<(), String> {
    let failed = || failure(pipeline).unwrap_or_else(|| format!("couldn't get to {state:?}"));
    pipeline.set_state(state).map_err(|_| failed())?;
    let (result, _, _) = pipeline.state(gst::ClockTime::from_seconds(30));
    result.map(|_| ()).map_err(|_| failed())
}

/// Seconds as GStreamer's time.
pub fn clock_time(seconds: f64) -> gst::ClockTime {
    gst::ClockTime::from_nseconds((seconds.max(0.0) * 1e9) as u64)
}

/// GStreamer's time in seconds.
pub fn seconds(time: gst::ClockTime) -> f64 {
    time.nseconds() as f64 / 1e9
}
