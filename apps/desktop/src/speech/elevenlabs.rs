// ElevenLabs (elevenlabs.io/docs/api-reference): the account's voices and
// models, the characters left this month, and speech as raw samples, which
// every plan gets at 24 kHz.

use std::collections::BTreeMap;

use reqwest::Client;
use serde::Deserialize;
use serde_json::{Value, json};

use super::{Model, Quota, Voice, endpoint, fetch_bytes, fetch_json};

pub const BASE: &str = "https://api.elevenlabs.io";
pub const SAMPLE_RATE: u32 = 24_000;
const KEY_HEADER: &str = "xi-api-key";

#[derive(Deserialize)]
struct VoiceList {
    #[serde(default)]
    voices: Vec<VoiceEntry>,
}

#[derive(Deserialize)]
struct VoiceEntry {
    voice_id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    /// accent, age, gender, use_case, language... as the voice has them.
    #[serde(default)]
    labels: Option<BTreeMap<String, Value>>,
    #[serde(default)]
    verified_languages: Option<Vec<VerifiedLanguage>>,
}

#[derive(Deserialize)]
struct VerifiedLanguage {
    #[serde(default)]
    language: Option<String>,
}

#[derive(Deserialize)]
struct ModelEntry {
    model_id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    can_do_text_to_speech: bool,
}

#[derive(Deserialize)]
struct Subscription {
    character_count: u64,
    character_limit: u64,
}

fn nonempty(text: &str) -> Option<String> {
    Some(text.trim())
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

fn voice(entry: VoiceEntry) -> Voice {
    let labels = entry.labels.unwrap_or_default();
    let label = |key: &str| labels.get(key).and_then(Value::as_str).and_then(nonempty);
    let language = label("language").or_else(|| {
        entry
            .verified_languages
            .unwrap_or_default()
            .into_iter()
            .find_map(|verified| verified.language.as_deref().and_then(nonempty))
    });
    // Its own description, or else its labels: "american, young, female".
    let description = entry.description.as_deref().and_then(nonempty).or_else(|| {
        let words: Vec<&str> = labels
            .iter()
            .filter(|(key, _)| *key != "language")
            .filter_map(|(_, value)| value.as_str().map(str::trim))
            .filter(|word| !word.is_empty())
            .collect();
        (!words.is_empty()).then(|| words.join(", "))
    });
    Voice {
        name: entry
            .name
            .as_deref()
            .and_then(nonempty)
            .unwrap_or_else(|| entry.voice_id.clone()),
        id: entry.voice_id,
        language,
        description,
    }
}

/// The account's voices: its own, and those it has added.
pub async fn voices(client: &Client, base: &str, key: &str) -> Result<Vec<Voice>, String> {
    let url = endpoint(base, &["v1", "voices"])?;
    let list: VoiceList = fetch_json(client.get(url).header(KEY_HEADER, key)).await?;
    Ok(list.voices.into_iter().map(voice).collect())
}

/// The models that speak text.
pub async fn models(client: &Client, base: &str, key: &str) -> Result<Vec<Model>, String> {
    let url = endpoint(base, &["v1", "models"])?;
    let models: Vec<ModelEntry> = fetch_json(client.get(url).header(KEY_HEADER, key)).await?;
    Ok(models
        .into_iter()
        .filter(|model| model.can_do_text_to_speech)
        .map(|model| Model {
            name: model.name.unwrap_or_else(|| model.model_id.clone()),
            id: model.model_id,
        })
        .collect())
}

/// The characters spoken and allowed this billing period.
pub async fn quota(client: &Client, base: &str, key: &str) -> Result<Quota, String> {
    let url = endpoint(base, &["v1", "user", "subscription"])?;
    let subscription: Subscription = fetch_json(client.get(url).header(KEY_HEADER, key)).await?;
    Ok(Quota {
        used: subscription.character_count,
        limit: subscription.character_limit,
    })
}

pub struct Speak<'a> {
    pub text: &'a str,
    pub voice: &'a str,
    /// ElevenLabs's default (eleven_multilingual_v2) if none.
    pub model: Option<&'a str>,
}

/// The text spoken: 16-bit mono samples at 24 kHz, little-endian.
pub async fn speak(
    client: &Client,
    base: &str,
    key: &str,
    request: Speak<'_>,
) -> Result<Vec<u8>, String> {
    let mut url = endpoint(base, &["v1", "text-to-speech", request.voice])?;
    url.query_pairs_mut()
        .append_pair("output_format", &format!("pcm_{SAMPLE_RATE}"));
    let mut body = json!({ "text": request.text });
    if let Some(model) = request.model {
        body["model_id"] = model.into();
    }
    fetch_bytes(client.post(url).header(KEY_HEADER, key).json(&body)).await
}
