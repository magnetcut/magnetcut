// Subtitles spoken (docs/VOICEOVER.md): by ElevenLabs or OpenAI, with the
// user's own key, or by the system's own voices. The keys are kept in the
// system's keychain and sent only to their own provider: the editor never
// gets one back. Whoever speaks, the editor gets a WAV file, mono, 16-bit.
// Nothing is sent anywhere until the editor asks.

mod elevenlabs;
mod openai;
mod wav;

// The system's voices: AVSpeechSynthesizer on macOS, WinRT's on Windows,
// espeak-ng's on Linux.
#[cfg(target_os = "macos")]
#[path = "speech/avspeech.rs"]
mod system;
#[cfg(target_os = "linux")]
#[path = "speech/espeak.rs"]
mod system;
#[cfg(windows)]
#[path = "speech/winrt.rs"]
mod system;
// For its tests elsewhere.
#[cfg(all(test, not(target_os = "linux")))]
#[allow(dead_code)]
mod espeak;

#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use reqwest::{Client, RequestBuilder, StatusCode, Url};
use serde::Serialize;
use serde::de::DeserializeOwned;
use tauri::ipc::Response;
use tauri::{AppHandle, State};

/// A voice to pick.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Voice {
    /// What `speak` is given.
    id: String,
    name: String,
    /// A BCP-47 tag (en-US) or a language code (en), when the provider says.
    language: Option<String>,
    description: Option<String>,
}

/// A provider's text-to-speech model.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    id: String,
    name: String,
}

/// The characters used and allowed this billing period.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Quota {
    used: u64,
    limit: u64,
}

/// Which providers have a key in the keychain.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Keys {
    elevenlabs: bool,
    openai: bool,
}

#[derive(Clone, Copy)]
enum Provider {
    ElevenLabs,
    OpenAi,
    /// The voices of the system the app runs on, which need no key.
    System,
}

impl Provider {
    fn named(name: &str) -> Result<Self, String> {
        match name {
            "elevenlabs" => Ok(Self::ElevenLabs),
            "openai" => Ok(Self::OpenAi),
            "system" => Ok(Self::System),
            _ => Err(format!("no speech provider {name:?}")),
        }
    }

    /// Its key's account in the keychain.
    fn account(self) -> Option<&'static str> {
        match self {
            Self::ElevenLabs => Some("elevenlabs"),
            Self::OpenAi => Some("openai"),
            Self::System => None,
        }
    }

    fn title(self) -> &'static str {
        match self {
            Self::ElevenLabs => "ElevenLabs",
            Self::OpenAi => "OpenAI",
            Self::System => "this computer",
        }
    }
}

/// The HTTP client, made the first time it's needed, and the keys as read
/// from the keychain, each once (none for one that isn't set).
#[derive(Default)]
pub struct Speech {
    client: OnceLock<Client>,
    keys: Mutex<HashMap<&'static str, Option<String>>>,
}

impl Speech {
    fn client(&self) -> Result<&Client, String> {
        if let Some(client) = self.client.get() {
            return Ok(client);
        }
        let client = client_builder()
            .build()
            .map_err(|error| error.to_string())?;
        Ok(self.client.get_or_init(|| client))
    }

    /// The provider's key, from the keychain: none if it isn't set.
    async fn key(&self, app: &AppHandle, provider: Provider) -> Result<Option<String>, String> {
        let Some(account) = provider.account() else {
            return Ok(None);
        };
        if let Some(key) = lock(&self.keys).get(account) {
            return Ok(key.clone());
        }
        let service = service(app);
        let key = blocking(move || keychain::read(&service, account)).await?;
        lock(&self.keys).insert(account, key.clone());
        Ok(key)
    }

    /// The key a request needs: an error that says so if there's none.
    async fn needed_key(&self, app: &AppHandle, provider: Provider) -> Result<String, String> {
        self.key(app, provider)
            .await?
            .ok_or_else(|| format!("No {} key: add one in Settings.", provider.title()))
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

fn client_builder() -> reqwest::ClientBuilder {
    Client::builder()
        .user_agent(concat!("MagnetCut/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(180))
}

/// The keychain's service for the keys: the app's identifier, then `.speech`.
fn service(app: &AppHandle) -> String {
    format!("{}.speech", app.config().identifier)
}

/// Runs work that blocks (the keychain, the system's voices) off the
/// async runtime's threads.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| error.to_string())?
}

/// Which providers have a key.
#[tauri::command]
pub async fn speech_keys(app: AppHandle, speech: State<'_, Speech>) -> Result<Keys, String> {
    Ok(Keys {
        elevenlabs: speech.key(&app, Provider::ElevenLabs).await?.is_some(),
        openai: speech.key(&app, Provider::OpenAi).await?.is_some(),
    })
}

/// Keeps a provider's key in the keychain, or with none removes it.
#[tauri::command]
pub async fn set_speech_key(
    app: AppHandle,
    speech: State<'_, Speech>,
    provider: String,
    key: Option<String>,
) -> Result<(), String> {
    let provider = Provider::named(&provider)?;
    let account = provider
        .account()
        .ok_or("the voices on this computer need no key")?;
    let key = key
        .map(|key| key.trim().to_owned())
        .filter(|key| !key.is_empty());
    let service = service(&app);
    let kept = key.clone();
    blocking(move || keychain::write(&service, account, kept.as_deref())).await?;
    lock(&speech.keys).insert(account, key);
    Ok(())
}

/// The voices a provider has: for ElevenLabs, the account's.
#[tauri::command]
pub async fn speech_voices(
    app: AppHandle,
    speech: State<'_, Speech>,
    provider: String,
) -> Result<Vec<Voice>, String> {
    match Provider::named(&provider)? {
        Provider::ElevenLabs => {
            let key = speech.needed_key(&app, Provider::ElevenLabs).await?;
            elevenlabs::voices(speech.client()?, elevenlabs::BASE, &key).await
        }
        Provider::OpenAi => Ok(openai::voices()),
        Provider::System => blocking(system::voices).await,
    }
}

/// The provider's text-to-speech models, as it lists them now: none for the
/// voices on this computer.
#[tauri::command]
pub async fn speech_models(
    app: AppHandle,
    speech: State<'_, Speech>,
    provider: String,
) -> Result<Vec<Model>, String> {
    match Provider::named(&provider)? {
        Provider::ElevenLabs => {
            let key = speech.needed_key(&app, Provider::ElevenLabs).await?;
            elevenlabs::models(speech.client()?, elevenlabs::BASE, &key).await
        }
        Provider::OpenAi => {
            let key = speech.needed_key(&app, Provider::OpenAi).await?;
            openai::models(speech.client()?, openai::BASE, &key).await
        }
        Provider::System => Ok(Vec::new()),
    }
}

/// What's left to speak this month: ElevenLabs only.
#[tauri::command]
pub async fn speech_quota(
    app: AppHandle,
    speech: State<'_, Speech>,
    provider: String,
) -> Result<Option<Quota>, String> {
    match Provider::named(&provider)? {
        Provider::ElevenLabs => {
            let key = speech.needed_key(&app, Provider::ElevenLabs).await?;
            elevenlabs::quota(speech.client()?, elevenlabs::BASE, &key)
                .await
                .map(Some)
        }
        Provider::OpenAi | Provider::System => Ok(None),
    }
}

/// `text` spoken by `voice`, as a WAV file's bytes. The model is the
/// provider's (its default if none); the instructions ("calm, warm") are sent
/// only when given, for the OpenAI models that take them.
#[tauri::command]
pub async fn speak(
    app: AppHandle,
    speech: State<'_, Speech>,
    provider: String,
    text: String,
    voice: String,
    model: Option<String>,
    instructions: Option<String>,
) -> Result<Response, String> {
    let provider = Provider::named(&provider)?;
    let text = text.trim().to_owned();
    if text.is_empty() {
        return Err("nothing to speak".into());
    }
    if provider.account().is_some() && voice.trim().is_empty() {
        return Err("no voice picked".into());
    }
    let model = model.filter(|model| !model.trim().is_empty());
    let file = match provider {
        Provider::ElevenLabs => {
            let key = speech.needed_key(&app, provider).await?;
            let request = elevenlabs::Speak {
                text: &text,
                voice: &voice,
                model: model.as_deref(),
            };
            let pcm = elevenlabs::speak(speech.client()?, elevenlabs::BASE, &key, request).await?;
            wav::from_pcm(elevenlabs::SAMPLE_RATE, &pcm)
        }
        Provider::OpenAi => {
            let key = speech.needed_key(&app, provider).await?;
            let request = openai::Speak {
                text: &text,
                voice: &voice,
                model: model.as_deref(),
                instructions: instructions
                    .as_deref()
                    .map(str::trim)
                    .filter(|i| !i.is_empty()),
            };
            let pcm = openai::speak(speech.client()?, openai::BASE, &key, request).await?;
            wav::from_pcm(openai::SAMPLE_RATE, &pcm)
        }
        Provider::System => blocking(move || system::speak(&text, &voice)).await?,
    };
    if wav::is_empty(&file) {
        return Err(format!("{} gave back no sound", provider.title()));
    }
    Ok(Response::new(file))
}

/// A provider's endpoint: its base and the path's segments, each escaped.
fn endpoint(base: &str, segments: &[&str]) -> Result<Url, String> {
    let mut url = Url::parse(base).map_err(|error| error.to_string())?;
    url.path_segments_mut()
        .map_err(|()| format!("{base} can't be a base"))?
        .pop_if_empty()
        .extend(segments);
    Ok(url)
}

/// Sends a request: the answer if it succeeded, or else the provider's own
/// words for what went wrong (a bad key, the quota spent).
async fn send(request: RequestBuilder) -> Result<reqwest::Response, String> {
    let response = request.send().await.map_err(unreachable)?;
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    let body = response.bytes().await.unwrap_or_default();
    Err(error_message(status, &body))
}

async fn fetch_json<T: DeserializeOwned>(request: RequestBuilder) -> Result<T, String> {
    let body = fetch_bytes(request).await?;
    serde_json::from_slice(&body).map_err(|error| format!("an answer not understood: {error}"))
}

async fn fetch_bytes(request: RequestBuilder) -> Result<Vec<u8>, String> {
    let response = send(request).await?;
    let body = response.bytes().await.map_err(unreachable)?;
    Ok(body.to_vec())
}

/// What a request that never got its answer says.
fn unreachable(error: reqwest::Error) -> String {
    let host = error
        .url()
        .and_then(|url| url.host_str())
        .unwrap_or("the provider")
        .to_owned();
    if error.is_timeout() {
        return format!("{host} took too long to answer");
    }
    // The innermost cause says the most: a name not found, a refused
    // connection.
    let mut cause: &dyn std::error::Error = &error;
    while let Some(source) = cause.source() {
        cause = source;
    }
    format!("Can't reach {host}: {cause}")
}

/// The message in a provider's error body: OpenAI's `error.message`,
/// ElevenLabs's `detail.message`, `detail` or `detail[0].msg`. The status if
/// there's none.
fn error_message(status: StatusCode, body: &[u8]) -> String {
    let value: serde_json::Value = serde_json::from_slice(body).unwrap_or_default();
    let error = value.get("error");
    let detail = value.get("detail");
    let candidates = [
        error.and_then(|error| error.get("message")),
        error,
        detail.and_then(|detail| detail.get("message")),
        detail
            .and_then(|detail| detail.get(0))
            .and_then(|first| first.get("msg")),
        detail,
        value.get("message"),
    ];
    let message = candidates
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
        .map(str::trim)
        .find(|message| !message.is_empty());
    if let Some(message) = message {
        return message.to_owned();
    }
    let text = String::from_utf8_lossy(body);
    let text = text.trim();
    if text.is_empty() || text.len() > 200 || text.starts_with('<') {
        return status.to_string();
    }
    format!("{status}: {text}")
}

/// The keys, in the macOS Keychain, the Windows Credential Manager or the
/// Secret Service, under the app's service and the provider's account.
mod keychain {
    use keyring::{Entry, Error};

    pub fn read(service: &str, account: &str) -> Result<Option<String>, String> {
        match entry(service, account)?.get_password() {
            Ok(key) => Ok(Some(key)),
            Err(Error::NoEntry) => Ok(None),
            Err(error) => Err(failed(error)),
        }
    }

    /// Keeps the key, or with none removes it.
    pub fn write(service: &str, account: &str, key: Option<&str>) -> Result<(), String> {
        let entry = entry(service, account)?;
        match key {
            Some(key) => entry.set_password(key).map_err(failed),
            None => match entry.delete_credential() {
                Ok(()) | Err(Error::NoEntry) => Ok(()),
                Err(error) => Err(failed(error)),
            },
        }
    }

    fn entry(service: &str, account: &str) -> Result<Entry, String> {
        Entry::new(service, account).map_err(failed)
    }

    fn failed(error: Error) -> String {
        format!("The keychain: {error}")
    }
}

/// No voices of its own on other systems.
#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
mod system {
    pub fn voices() -> Result<Vec<super::Voice>, String> {
        Ok(Vec::new())
    }

    pub fn speak(_text: &str, _voice: &str) -> Result<Vec<u8>, String> {
        Err("no voices on this system".into())
    }
}
