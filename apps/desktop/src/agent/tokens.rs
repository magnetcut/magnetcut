// The agents the user added in Settings and whether agent mode is on, kept
// in the app's data folder (agents.json). A token is shown once, when the
// agent is added; only its SHA-256 is kept.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// An agent allowed in: its name, and its token's hash.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    pub id: String,
    pub name: String,
    pub hash: String,
    /// Seconds since 1970.
    pub created: u64,
    pub last_used: Option<u64>,
}

/// What's kept between launches.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Store {
    pub enabled: bool,
    /// The port served on, picked once and kept so the lines pasted keep
    /// working; 0 until it's picked.
    pub port: u16,
    pub agents: Vec<Agent>,
    /// In the App Store edition, folders agents may use, picked in Settings.
    #[serde(default)]
    pub folders: Vec<Folder>,
}

/// A folder agents may use: where it is, and its bookmark (base64).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub path: String,
    pub bookmark: Option<String>,
}

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_secs())
}

/// A token's hash, as kept: hexadecimal SHA-256.
pub fn hash(token: &str) -> String {
    Sha256::digest(token.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// A new token: `mc_` and 32 random bytes, base64url.
pub fn new_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|error| error.to_string())?;
    Ok(format!("mc_{}", URL_SAFE_NO_PAD.encode(bytes)))
}

/// A short random id, for an agent in the list.
fn new_id() -> Result<String, String> {
    let mut bytes = [0u8; 6];
    getrandom::fill(&mut bytes).map_err(|error| error.to_string())?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

impl Store {
    /// The store at `path`; the default where there's none or it can't be read.
    pub fn load(path: &Path) -> Self {
        std::fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> Result<(), String> {
        if let Some(folder) = path.parent() {
            std::fs::create_dir_all(folder).map_err(|error| error.to_string())?;
        }
        let bytes = serde_json::to_vec_pretty(self).map_err(|error| error.to_string())?;
        // Written whole, then moved into place: never half a file.
        let partial = path.with_extension("json.partial");
        std::fs::write(&partial, bytes).map_err(|error| error.to_string())?;
        restrict(&partial);
        std::fs::rename(&partial, path).map_err(|error| error.to_string())
    }

    /// Adds an agent: its token, which isn't kept.
    pub fn add(&mut self, name: &str) -> Result<(Agent, String), String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("An agent needs a name".into());
        }
        let token = new_token()?;
        let agent = Agent {
            id: new_id()?,
            name: name.to_owned(),
            hash: hash(&token),
            created: now(),
            last_used: None,
        };
        self.agents.push(agent.clone());
        Ok((agent, token))
    }

    pub fn revoke(&mut self, id: &str) -> bool {
        let before = self.agents.len();
        self.agents.retain(|agent| agent.id != id);
        self.agents.len() != before
    }

    /// Where in the list the agent a token is for is, if it's one of theirs.
    pub fn position(&self, token: &str) -> Option<usize> {
        let hashed = hash(token);
        self.agents
            .iter()
            .position(|agent| same(agent.hash.as_bytes(), hashed.as_bytes()))
    }
}

/// Whether two byte strings are the same, taking as long either way.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Readable by the user only, where the system has such modes.
fn restrict(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    let _ = path;
}

/// Where the store is kept.
pub fn location(data: PathBuf) -> PathBuf {
    data.join("agents.json")
}

#[cfg(test)]
mod tests {
    use super::{Store, hash};

    #[test]
    fn keeps_only_a_hash_and_finds_the_agent_by_its_token() {
        let mut store = Store::default();
        let (agent, token) = store.add("Claude Code").unwrap();
        assert!(token.starts_with("mc_") && token.len() > 40, "{token}");
        assert_eq!(agent.hash, hash(&token));
        assert_ne!(agent.hash, token);
        assert_eq!(store.position(&token), Some(0));
        assert!(store.position("mc_not-a-token").is_none());
        assert!(store.revoke(&agent.id));
        assert!(store.position(&token).is_none());
    }

    #[test]
    fn saves_and_loads_whole() {
        let folder = std::env::temp_dir().join(format!("agents-{}", std::process::id()));
        let path = super::location(folder.clone());
        let mut store = Store {
            enabled: true,
            port: 47213,
            ..Store::default()
        };
        store.add("Codex").unwrap();
        store.save(&path).unwrap();
        assert_eq!(Store::load(&path), store);
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("mc_"), "a token was kept: {text}");
        std::fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn needs_a_name() {
        assert!(Store::default().add("  ").is_err());
    }
}
