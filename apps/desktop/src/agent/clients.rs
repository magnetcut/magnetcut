// Settings, Agents, Connect (docs/AUTOMATION.md): MagnetCut adds itself to
// Claude Code, Codex or OpenCode, each with a token of its own, and Disconnect
// takes it out. Claude Code gets the MagnetCut plugin from this repository's
// marketplace (plugins/magnetcut: the MCP server and a skill) by its own
// command line, the token on standard input. Codex (which starts `magnetcut
// --mcp`) and OpenCode (which reaches the server by HTTP) have their settings
// edited instead, the user's comments kept: their commands take the token as
// an argument, which other users of the computer can see, and OpenCode's
// writes to a project's settings in the folder it runs in, if there's one.
// Not in the App Store edition, whose sandbox runs no other program.

use std::collections::HashSet;
use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use jsonc_parser::ParseOptions;
use jsonc_parser::cst::CstRootNode;
use jsonc_parser::json;
use serde::{Deserialize, Serialize};
use toml_edit::{Array, DocumentMut, Item, Table, value};

/// The marketplace Claude Code installs the plugin from: this repository, on
/// GitHub. MAGNETCUT_PLUGIN_MARKETPLACE names another (a folder, to try the
/// plugin before it's pushed).
const MARKETPLACE: &str = "magnetcut/magnetcut";
const MARKETPLACE_ENV: &str = "MAGNETCUT_PLUGIN_MARKETPLACE";
/// The marketplace's name, in its marketplace.json.
const MARKETPLACE_NAME: &str = "magnetcut";
const PLUGIN: &str = "magnetcut@magnetcut";
/// The server's name in each agent's settings.
const SERVER: &str = "magnetcut";
/// How long one of Claude Code's commands may take: it clones the marketplace.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(120);
/// How long the login shell may take to say its environment.
const SHELL_TIMEOUT: Duration = Duration::from_secs(5);
/// How long a command's output may go on after it ends: a program it started
/// may hold the pipe.
const OUTPUT_TIMEOUT: Duration = Duration::from_secs(2);
/// The files OpenCode reads its settings from, in its folder.
const OPENCODE_FILES: [&str; 3] = ["config.json", "opencode.json", "opencode.jsonc"];
/// OpenCode's settings when there were none, as OpenCode starts them.
const OPENCODE_NEW: &str = "{\n  \"$schema\": \"https://opencode.ai/config.json\"\n}\n";
const NO_HOME: &str = "There's no home folder to find the agent's settings in";

/// An agent MagnetCut can add itself to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Client {
    #[serde(rename = "claude-code")]
    ClaudeCode,
    #[serde(rename = "codex")]
    Codex,
    #[serde(rename = "opencode")]
    OpenCode,
}

impl Client {
    pub const ALL: [Client; 3] = [Client::ClaudeCode, Client::Codex, Client::OpenCode];

    pub fn name(self) -> &'static str {
        match self {
            Client::ClaudeCode => "Claude Code",
            Client::Codex => "Codex",
            Client::OpenCode => "OpenCode",
        }
    }

    fn program(self) -> &'static str {
        match self {
            Client::ClaudeCode => "claude",
            Client::Codex => "codex",
            Client::OpenCode => "opencode",
        }
    }
}

/// What Settings shows of an agent: whether it's on this computer.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientView {
    client: Client,
    name: &'static str,
    installed: bool,
}

/// The agents MagnetCut can add itself to, and which are installed.
pub fn detect() -> Vec<ClientView> {
    Client::ALL
        .into_iter()
        .map(|client| ClientView {
            client,
            name: client.name(),
            installed: find(client.program()).is_some(),
        })
        .collect()
}

/// Adds MagnetCut to `client`, with `token`: `url` the server's, `program`
/// this app's, for `--mcp`. Says why not if it can't.
pub fn connect(client: Client, url: &str, token: &str, program: &Path) -> Result<(), String> {
    let found = find(client.program())
        .ok_or_else(|| format!("{} isn't installed on this computer", client.name()))?;
    match client {
        Client::ClaudeCode => {
            let marketplace = std::env::var(MARKETPLACE_ENV).unwrap_or_else(|_| MARKETPLACE.into());
            run_claude(&found, &claude_connect_steps(url, token, &marketplace))
        }
        Client::Codex => connect_codex(program, url, token),
        Client::OpenCode => connect_opencode(url, token),
    }
}

/// Takes MagnetCut out of `client`. Says why not if it can't.
pub fn disconnect(client: Client) -> Result<(), String> {
    match client {
        Client::ClaudeCode => {
            let found = find(client.program())
                .ok_or_else(|| format!("{} isn't installed on this computer", client.name()))?;
            run_claude(&found, &claude_disconnect_steps())
        }
        Client::Codex => remove_from(
            &codex_settings().ok_or_else(|| NO_HOME.to_owned())?,
            without_codex_server,
            "[mcp_servers.magnetcut] out of it",
        ),
        Client::OpenCode => {
            let folder = opencode_folder().ok_or_else(|| NO_HOME.to_owned())?;
            for name in OPENCODE_FILES {
                remove_from(
                    &folder.join(name),
                    without_opencode_server,
                    OPENCODE_BY_HAND,
                )?;
            }
            Ok(())
        }
    }
}

// Claude Code.

/// One of Claude Code's commands: its arguments, what it reads, and whether
/// it may fail (one that tidies up first, with nothing to tidy).
#[derive(Debug, PartialEq)]
struct Step {
    args: Vec<String>,
    input: Option<String>,
    may_fail: bool,
}

fn step(args: &[&str]) -> Step {
    Step {
        args: args.iter().map(|arg| (*arg).to_owned()).collect(),
        input: None,
        may_fail: false,
    }
}

fn tidy(args: &[&str]) -> Step {
    Step {
        may_fail: true,
        ..step(args)
    }
}

/// The commands that give Claude Code the plugin, with MagnetCut's address and
/// the token.
fn claude_connect_steps(url: &str, token: &str, marketplace: &str) -> Vec<Step> {
    vec![
        // An entry pasted from Settings before: the plugin's now.
        tidy(&["mcp", "remove", SERVER, "--scope", "user"]),
        tidy(&["plugin", "marketplace", "add", marketplace]),
        tidy(&["plugin", "marketplace", "update", MARKETPLACE_NAME]),
        tidy(&["plugin", "uninstall", PLUGIN, "--scope", "user"]),
        step(&["plugin", "install", PLUGIN, "--scope", "user"]),
        // The token on standard input, not where other programs see it.
        Step {
            input: Some(
                serde_json::json!({ "magnetcut_token": token, "magnetcut_url": url }).to_string(),
            ),
            ..step(&["plugin", "configure", PLUGIN, "--values-stdin"])
        },
    ]
}

fn claude_disconnect_steps() -> Vec<Step> {
    vec![step(&["plugin", "uninstall", PLUGIN, "--scope", "user"])]
}

/// Runs Claude Code's commands, in order, from a folder of no project's that
/// only this user can use (the system's temporary folder is everyone's on
/// Linux, and a project's settings there would be read).
fn run_claude(program: &Path, steps: &[Step]) -> Result<(), String> {
    let folder = tempfile::Builder::new()
        .prefix("magnetcut-")
        .tempdir()
        .map_err(|error| format!("Couldn't make a folder to run Claude Code in: {error}"))?;
    for step in steps {
        let mut command = Command::new(program);
        command
            .args(&step.args)
            .env("PATH", search_path())
            .current_dir(folder.path())
            .stdin(if step.input.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            });
        if let Some(settings) = setting_var("CLAUDE_CONFIG_DIR") {
            command.env("CLAUDE_CONFIG_DIR", settings);
        }
        let (ok, output) = finish(command, step.input.as_deref(), COMMAND_TIMEOUT)
            .ok_or_else(|| "Claude Code didn't start, or didn't answer in time".to_owned())?;
        if !ok && !step.may_fail {
            let said = output.trim();
            return Err(if said.is_empty() {
                format!("Claude Code said no to `{}`", step.args.join(" "))
            } else {
                format!("Claude Code: {said}")
            });
        }
    }
    Ok(())
}

// Codex.

/// Codex's settings: $CODEX_HOME/config.toml, or ~/.codex/config.toml.
fn codex_settings() -> Option<PathBuf> {
    setting_var("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::home_dir().map(|home| home.join(".codex")))
        .map(|folder| folder.join("config.toml"))
}

fn connect_codex(program: &Path, url: &str, token: &str) -> Result<(), String> {
    let path = codex_settings().ok_or_else(|| NO_HOME.to_owned())?;
    let text = read_settings(&path)?.unwrap_or_default();
    let edited = with_codex_server(&text, program, url, token)
        .map_err(|error| format!("Couldn't read {}: {error}", path.display()))?;
    write_settings(&path, &edited, true)
}

/// Codex's settings with MagnetCut's server, as `codex mcp add` writes it,
/// started with the address and token in its environment, in place of any
/// there was: everything else as it was, comments included.
pub fn with_codex_server(
    text: &str,
    program: &Path,
    url: &str,
    token: &str,
) -> Result<String, String> {
    let mut settings: DocumentMut = text.parse().map_err(toml_error)?;
    let servers = settings.entry("mcp_servers").or_insert({
        let mut servers = Table::new();
        servers.set_implicit(true);
        Item::Table(servers)
    });
    let servers = servers
        .as_table_like_mut()
        .ok_or_else(|| "its mcp_servers isn't a table".to_owned())?;
    let mut env = Table::new();
    env.insert("MAGNETCUT_TOKEN", value(token));
    env.insert("MAGNETCUT_URL", value(url));
    let mut server = Table::new();
    server.insert("command", value(program.to_string_lossy().as_ref()));
    server.insert("args", value(Array::from_iter(["--mcp"])));
    server.insert("env", Item::Table(env));
    servers.insert(SERVER, Item::Table(server));
    Ok(settings.to_string())
}

/// Codex's settings without MagnetCut's server, everything else as it was:
/// None if it isn't there.
pub fn without_codex_server(text: &str) -> Result<Option<String>, String> {
    let mut settings: DocumentMut = text.parse().map_err(toml_error)?;
    let removed = settings
        .get_mut("mcp_servers")
        .and_then(Item::as_table_like_mut)
        .and_then(|servers| servers.remove(SERVER))
        .is_some();
    Ok(removed.then(|| settings.to_string()))
}

/// A TOML error in one line: where, and what (its message has the line
/// quoted between).
fn toml_error(error: toml_edit::TomlError) -> String {
    let text = error.to_string();
    let lines: Vec<&str> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect();
    match (lines.first(), lines.last()) {
        (Some(first), Some(last)) if lines.len() > 1 => format!("{first}: {last}"),
        _ => text.trim().to_owned(),
    }
}

// OpenCode.

const OPENCODE_BY_HAND: &str = "\"magnetcut\" out of its \"mcp\"";

/// OpenCode's settings folder: $XDG_CONFIG_HOME/opencode, or
/// ~/.config/opencode, on every system.
fn opencode_folder() -> Option<PathBuf> {
    setting_var("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::home_dir().map(|home| home.join(".config")))
        .map(|config| config.join("opencode"))
}

fn connect_opencode(url: &str, token: &str) -> Result<(), String> {
    let folder = opencode_folder().ok_or_else(|| NO_HOME.to_owned())?;
    // Its .jsonc if there's one, else the file `opencode mcp add` makes.
    let name = if folder.join("opencode.jsonc").is_file() {
        "opencode.jsonc"
    } else {
        "opencode.json"
    };
    for other in OPENCODE_FILES.into_iter().filter(|other| *other != name) {
        remove_from(
            &folder.join(other),
            without_opencode_server,
            OPENCODE_BY_HAND,
        )?;
    }
    let path = folder.join(name);
    let text = read_settings(&path)?.unwrap_or_else(|| OPENCODE_NEW.to_owned());
    let edited = with_opencode_server(&text, url, token)
        .map_err(|error| format!("Couldn't read {}: {error}", path.display()))?;
    write_settings(&path, &edited, true)
}

/// OpenCode's settings with MagnetCut's server, as `opencode mcp add` writes
/// it, in place of any there was: everything else as it was, comments
/// included.
pub fn with_opencode_server(text: &str, url: &str, token: &str) -> Result<String, String> {
    let root =
        CstRootNode::parse(text, &ParseOptions::default()).map_err(|error| error.to_string())?;
    let server = json!({
        "type": "remote",
        "url": url,
        "headers": { "Authorization": (format!("Bearer {token}")) }
    });
    let servers = root.object_value_or_set().object_value_or_set("mcp");
    match servers.get(SERVER) {
        Some(existing) => existing.set_value(server),
        None => {
            servers.append(SERVER, server);
        }
    }
    Ok(root.to_string())
}

/// OpenCode's settings without MagnetCut's server, everything else as it
/// was, comments included: None if it isn't there.
pub fn without_opencode_server(text: &str) -> Result<Option<String>, String> {
    let root =
        CstRootNode::parse(text, &ParseOptions::default()).map_err(|error| error.to_string())?;
    let Some(server) = root
        .object_value()
        .and_then(|settings| settings.object_value("mcp"))
        .and_then(|servers| servers.get(SERVER))
    else {
        return Ok(None);
    };
    server.remove();
    Ok(Some(root.to_string()))
}

// An agent's settings file.

/// The settings at `path`: None if there's no such file.
fn read_settings(path: &Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Couldn't read {}: {error}", path.display())),
    }
}

/// Takes MagnetCut out of the settings at `path`, if it's there: `without`
/// gives them without it, `by_hand` what the user takes out if they can't be
/// read.
fn remove_from(
    path: &Path,
    without: fn(&str) -> Result<Option<String>, String>,
    by_hand: &str,
) -> Result<(), String> {
    let Some(text) = read_settings(path)? else {
        return Ok(());
    };
    match without(&text).map_err(|error| {
        format!(
            "Couldn't read {}: take {by_hand} by hand ({error})",
            path.display()
        )
    })? {
        Some(edited) => write_settings(path, &edited, false),
        None => Ok(()),
    }
}

/// Writes an agent's settings: whole, then moved into place, so never half a
/// file; through a link (to a dotfiles folder, say), the file it points at,
/// the link kept; and with the file's permissions, but only its owner's once
/// it holds a token (only theirs for a new file). Makes the folder if need be.
fn write_settings(path: &Path, text: &str, holds_token: bool) -> Result<(), String> {
    let failed = |error: std::io::Error| format!("Couldn't write {}: {error}", path.display());
    let target = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_owned());
    let (Some(folder), Some(name)) = (target.parent(), target.file_name()) else {
        return Err(format!("Couldn't write {}", path.display()));
    };
    make_folder(folder).map_err(failed)?;
    let mode = settings_mode(&target, holds_token);
    let partial = folder.join(format!(".{}.magnetcut-partial", name.to_string_lossy()));
    let written = write_new(&partial, text.as_bytes(), mode)
        .and_then(|()| std::fs::rename(&partial, &target));
    if written.is_err() {
        let _ = std::fs::remove_file(&partial);
    }
    written.map_err(failed)
}

/// A folder and those it's in, new ones only their owner's.
fn make_folder(folder: &Path) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(folder)
}

/// The permissions a settings file is written with (see `write_settings`).
#[cfg(unix)]
fn settings_mode(path: &Path, holds_token: bool) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    match std::fs::metadata(path) {
        Ok(metadata) => {
            let mode = metadata.permissions().mode() & 0o7777;
            if holds_token {
                (mode & 0o700) | 0o600
            } else {
                mode
            }
        }
        Err(_) => 0o600,
    }
}

/// On Windows, a file takes its folder's permissions: in the user's profile,
/// theirs.
#[cfg(not(unix))]
fn settings_mode(_path: &Path, _holds_token: bool) -> u32 {
    0
}

/// Writes a new file, only its owner's until it's whole, then with `mode`;
/// one left by a write that stopped halfway goes first.
fn write_new(path: &Path, bytes: &[u8], mode: u32) -> std::io::Result<()> {
    match std::fs::remove_file(path) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error),
        _ => {}
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(mode))?;
    }
    #[cfg(not(unix))]
    let _ = mode;
    file.sync_all()
}

// Finding their programs, and running them.

/// Starts `command` and waits for it, at most `timeout`: whether it worked,
/// and what it wrote, both streams. None if it couldn't start or took too long.
fn finish(mut command: Command, input: Option<&str>, timeout: Duration) -> Option<(bool, String)> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // No console window comes up.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().ok()?;
    if let (Some(text), Some(mut stdin)) = (input, child.stdin.take()) {
        // Small: it fits the pipe, whatever the program does first.
        let _ = stdin.write_all(text.as_bytes());
    }
    let (sender, receiver) = mpsc::channel();
    for pipe in [
        child
            .stdout
            .take()
            .map(|pipe| Box::new(pipe) as Box<dyn Read + Send>),
        child
            .stderr
            .take()
            .map(|pipe| Box::new(pipe) as Box<dyn Read + Send>),
    ]
    .into_iter()
    .flatten()
    {
        let sender = sender.clone();
        thread::spawn(move || {
            let mut pipe = pipe;
            let mut bytes = Vec::new();
            let _ = pipe.read_to_end(&mut bytes);
            let _ = sender.send(String::from_utf8_lossy(&bytes).into_owned());
        });
    }
    drop(sender);
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let mut output = String::new();
    while let Ok(text) = receiver.recv_timeout(OUTPUT_TIMEOUT) {
        output.push_str(&text);
    }
    status.map(|status| (status.success(), output))
}

/// Where to look for their programs: the PATH MagnetCut was started with,
/// the login shell's, and where their installers put them. Found once.
fn search_path() -> &'static OsString {
    static PATH: OnceLock<OsString> = OnceLock::new();
    PATH.get_or_init(|| {
        let mut folders: Vec<PathBuf> = Vec::new();
        for path in [std::env::var_os("PATH"), login_shell_var("PATH")]
            .into_iter()
            .flatten()
        {
            folders.extend(std::env::split_paths(&path));
        }
        folders.extend(install_folders());
        joined_path(folders)
    })
}

/// Folders as one PATH: each once, none that can't be in it.
fn joined_path(folders: Vec<PathBuf>) -> OsString {
    let mut seen = HashSet::new();
    let folders: Vec<PathBuf> = folders
        .into_iter()
        .filter(|folder| !folder.as_os_str().is_empty())
        .filter(|folder| std::env::join_paths([folder]).is_ok())
        .filter(|folder| seen.insert(folder.clone()))
        .collect();
    std::env::join_paths(folders).unwrap_or_default()
}

/// Where an agent keeps its settings, if a variable says: MagnetCut's own
/// environment, or else the login shell's.
fn setting_var(name: &str) -> Option<OsString> {
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .or_else(|| login_shell_var(name))
}

/// A variable of the login shell's: the last line that sets it.
fn login_shell_var(name: &str) -> Option<OsString> {
    let prefix = format!("{name}=");
    login_shell_env()
        .lines()
        .rev()
        .find_map(|line| line.strip_prefix(prefix.as_str()))
        .filter(|value| !value.is_empty())
        .map(OsString::from)
}

/// The login shell's environment, as `env` prints it: what its profile sets
/// (Homebrew's PATH, nvm's, an agent's settings folder), which an app opened
/// from the Finder doesn't have. Read once.
fn login_shell_env() -> &'static str {
    static ENV: OnceLock<String> = OnceLock::new();
    ENV.get_or_init(|| read_login_shell_env().unwrap_or_default())
}

#[cfg(unix)]
fn read_login_shell_env() -> Option<String> {
    let shell = std::env::var_os("SHELL").unwrap_or_else(|| "/bin/sh".into());
    let mut command = Command::new(shell);
    // `env` prints PATH joined by colons in any shell, fish's too.
    command.args(["-ilc", "/usr/bin/env"]).stdin(Stdio::null());
    finish(command, None, SHELL_TIMEOUT).map(|(_, output)| output)
}

#[cfg(not(unix))]
fn read_login_shell_env() -> Option<String> {
    None
}

/// Where their installers put them, if not on the PATH.
fn install_folders() -> Vec<PathBuf> {
    let mut folders = Vec::new();
    if let Some(home) = std::env::home_dir() {
        for folder in [
            ".local/bin",
            ".claude/local",
            ".opencode/bin",
            ".bun/bin",
            ".npm-global/bin",
            ".volta/bin",
        ] {
            folders.push(home.join(folder));
        }
    }
    if cfg!(windows) {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            folders.push(PathBuf::from(appdata).join("npm"));
        }
    } else {
        folders.push("/opt/homebrew/bin".into());
        folders.push("/usr/local/bin".into());
    }
    folders
}

/// A program on the search path.
fn find(program: &str) -> Option<PathBuf> {
    find_in(program, search_path())
}

fn find_in(program: &str, path: &OsString) -> Option<PathBuf> {
    let names: Vec<String> = if cfg!(windows) {
        [".exe", ".cmd", ".bat"]
            .iter()
            .map(|extension| format!("{program}{extension}"))
            .collect()
    } else {
        vec![program.to_owned()]
    };
    std::env::split_paths(path)
        .flat_map(|folder| names.iter().map(move |name| folder.join(name)))
        .find(|candidate| is_program(candidate))
}

#[cfg(unix)]
fn is_program(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn is_program(path: &Path) -> bool {
    path.is_file()
}

#[cfg(test)]
mod tests {
    use super::*;

    const URL: &str = "http://127.0.0.1:47213/mcp";

    #[test]
    fn opencode_gets_magnetcut_with_everything_else_kept() {
        let text = r#"{
  // My settings.
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "other": { "type": "local", "command": ["other"] }
  },
  "theme": "dark"
}
"#;
        let edited = with_opencode_server(text, URL, "mc_secret").unwrap();
        assert!(edited.contains("// My settings."));
        assert!(edited.contains(r#""other": { "type": "local", "command": ["other"] }"#));
        assert!(edited.contains(r#""theme": "dark""#));
        let settings: serde_json::Value =
            serde_json::from_str(&edited.replace("// My settings.", "")).unwrap();
        assert_eq!(
            settings["mcp"]["magnetcut"],
            serde_json::json!({
                "type": "remote",
                "url": URL,
                "headers": { "Authorization": "Bearer mc_secret" }
            })
        );

        // Connected again: the one entry, the new token.
        let again = with_opencode_server(&edited, URL, "mc_new").unwrap();
        assert_eq!(again.matches("\"magnetcut\"").count(), 1);
        assert!(again.contains("Bearer mc_new"));
        assert!(!again.contains("mc_secret"));

        // And out again.
        let removed = without_opencode_server(&again).unwrap().unwrap();
        assert!(!removed.contains("magnetcut"));
        assert!(removed.contains("// My settings."));
        assert!(removed.contains(r#""theme": "dark""#));
    }

    #[test]
    fn opencode_settings_made_from_nothing() {
        let edited = with_opencode_server(OPENCODE_NEW, URL, "mc_secret").unwrap();
        let settings: serde_json::Value = serde_json::from_str(&edited).unwrap();
        assert_eq!(settings["$schema"], "https://opencode.ai/config.json");
        assert_eq!(settings["mcp"]["magnetcut"]["url"], URL);
        assert!(with_opencode_server("{ not json", URL, "mc_secret").is_err());
    }

    #[test]
    fn opencode_without_magnetcut_is_left_alone() {
        assert_eq!(
            without_opencode_server(r#"{ "mcp": { "other": {} } }"#),
            Ok(None)
        );
        assert_eq!(without_opencode_server(r#"{ "theme": "dark" }"#), Ok(None));
        assert!(without_opencode_server("{ not json").is_err());
    }

    /// What `codex mcp add magnetcut --env MAGNETCUT_URL=… --env
    /// MAGNETCUT_TOKEN=… -- /bin/magnetcut --mcp` wrote, Codex 0.170.
    #[test]
    fn codex_gets_what_its_own_command_writes() {
        let text = "# mine\nmodel = \"o3\"\n\n[mcp_servers.other]\ncommand = \"other\"\n";
        let edited =
            with_codex_server(text, Path::new("/bin/magnetcut"), URL, "mc_secret").unwrap();
        assert_eq!(
            edited,
            "# mine\nmodel = \"o3\"\n\n[mcp_servers.other]\ncommand = \"other\"\n\n\
             [mcp_servers.magnetcut]\ncommand = \"/bin/magnetcut\"\nargs = [\"--mcp\"]\n\n\
             [mcp_servers.magnetcut.env]\nMAGNETCUT_TOKEN = \"mc_secret\"\n\
             MAGNETCUT_URL = \"http://127.0.0.1:47213/mcp\"\n"
        );
        assert_eq!(without_codex_server(&edited), Ok(Some(text.to_owned())));
    }

    #[test]
    fn codex_entry_pasted_before_is_replaced() {
        // The line Settings gave to paste: by HTTP, the token in a variable.
        let text = "[mcp_servers.magnetcut]\nurl = \"http://127.0.0.1:47213/mcp\"\n\
                    bearer_token_env_var = \"MAGNETCUT_TOKEN\"\n";
        let edited =
            with_codex_server(text, Path::new("/bin/magnetcut"), URL, "mc_secret").unwrap();
        let settings: toml_edit::DocumentMut = edited.parse().unwrap();
        let server = &settings["mcp_servers"]["magnetcut"];
        assert!(server.get("url").is_none());
        assert!(server.get("bearer_token_env_var").is_none());
        assert_eq!(server["command"].as_str(), Some("/bin/magnetcut"));
        assert_eq!(server["env"]["MAGNETCUT_TOKEN"].as_str(), Some("mc_secret"));

        let empty = with_codex_server("", Path::new("/bin/magnetcut"), URL, "mc_secret").unwrap();
        assert!(empty.starts_with("[mcp_servers.magnetcut]\n"));
        assert_eq!(
            without_codex_server("[mcp_servers.magnetcut]\n"),
            Ok(Some(String::new()))
        );
    }

    #[test]
    fn codex_without_magnetcut_is_left_alone() {
        assert_eq!(
            without_codex_server("[mcp_servers.other]\ncommand = \"x\"\n"),
            Ok(None)
        );
        assert_eq!(without_codex_server("model = \"o3\"\n"), Ok(None));
        let error = without_codex_server("[not toml").unwrap_err();
        assert!(error.starts_with("TOML parse error at line 1"));
        assert!(!error.contains('\n'));
    }

    #[test]
    fn claude_code_gets_the_plugin_with_its_token_on_standard_input() {
        let steps = claude_connect_steps(URL, "mc_secret", MARKETPLACE);
        let install = steps
            .iter()
            .position(|step| step.args[..2] == ["plugin", "install"])
            .unwrap();
        assert!(!steps[install].may_fail);
        let configure = steps.last().unwrap();
        assert_eq!(
            configure.args,
            ["plugin", "configure", PLUGIN, "--values-stdin"]
        );
        let values: serde_json::Value =
            serde_json::from_str(configure.input.as_deref().unwrap()).unwrap();
        assert_eq!(values["magnetcut_token"], "mc_secret");
        assert_eq!(values["magnetcut_url"], URL);
        // Nowhere on a command line.
        assert!(
            steps
                .iter()
                .all(|step| step.args.iter().all(|arg| !arg.contains("mc_secret")))
        );
    }

    #[cfg(unix)]
    fn mode(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).unwrap().permissions().mode() & 0o7777
    }

    #[cfg(unix)]
    #[test]
    fn settings_holding_a_token_are_only_their_owners() {
        use std::os::unix::fs::PermissionsExt;
        let folder = tempfile::tempdir().unwrap();

        // A new one, in a new folder.
        let new = folder.path().join("codex/config.toml");
        write_settings(&new, "a", true).unwrap();
        assert_eq!(std::fs::read_to_string(&new).unwrap(), "a");
        assert_eq!(mode(&new), 0o600);
        assert_eq!(mode(new.parent().unwrap()), 0o700);

        // One everyone could read, now with a token.
        let shared = folder.path().join("opencode.json");
        std::fs::write(&shared, "{}").unwrap();
        std::fs::set_permissions(&shared, std::fs::Permissions::from_mode(0o644)).unwrap();
        write_settings(&shared, "{ token }", true).unwrap();
        assert_eq!(mode(&shared), 0o600);

        // One MagnetCut only takes itself out of keeps its permissions.
        let group = folder.path().join("config.json");
        std::fs::write(&group, "{ token }").unwrap();
        std::fs::set_permissions(&group, std::fs::Permissions::from_mode(0o640)).unwrap();
        write_settings(&group, "{}", false).unwrap();
        assert_eq!(mode(&group), 0o640);
        assert_eq!(std::fs::read_to_string(&group).unwrap(), "{}");

        // Nothing left over.
        let names: Vec<String> = std::fs::read_dir(folder.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert!(names.iter().all(|name| !name.contains("partial")));
    }

    #[cfg(unix)]
    #[test]
    fn settings_through_a_link_keep_it() {
        let folder = tempfile::tempdir().unwrap();
        let dotfiles = folder.path().join("dotfiles");
        std::fs::create_dir(&dotfiles).unwrap();
        let target = dotfiles.join("opencode.json");
        std::fs::write(&target, "{}").unwrap();
        let link = folder.path().join("opencode.json");
        std::os::unix::fs::symlink(&target, &link).unwrap();

        write_settings(&link, "{ token }", true).unwrap();
        assert!(
            std::fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "{ token }");
    }

    #[test]
    fn the_search_path_has_each_folder_once() {
        let path = joined_path(vec!["/a".into(), "/b".into(), "/a".into(), "".into()]);
        assert_eq!(
            std::env::split_paths(&path).collect::<Vec<_>>(),
            [PathBuf::from("/a"), PathBuf::from("/b")]
        );
    }

    /// By hand, against the agents installed, each pointed at a folder of
    /// its own (CLAUDE_CONFIG_DIR, CODEX_HOME, XDG_CONFIG_HOME) and the
    /// plugin at this checkout (MAGNETCUT_PLUGIN_MARKETPLACE): connects with
    /// MAGNETCUT_TRY_URL and MAGNETCUT_TRY_TOKEN, or disconnects with
    /// MAGNETCUT_TRY_DISCONNECT. `cargo test -p magnetcut try_clients --
    /// --ignored --nocapture`.
    #[test]
    #[ignore = "runs the agents installed"]
    fn try_clients() {
        let disconnecting = std::env::var_os("MAGNETCUT_TRY_DISCONNECT").is_some();
        let url = std::env::var("MAGNETCUT_TRY_URL").unwrap_or_default();
        let token = std::env::var("MAGNETCUT_TRY_TOKEN").unwrap_or_default();
        let program = std::env::current_exe().unwrap();
        for client in Client::ALL {
            let result = if disconnecting {
                disconnect(client)
            } else {
                connect(client, &url, &token, &program)
            };
            println!("{}: {result:?}", client.name());
            assert!(result.is_ok());
        }
    }

    #[cfg(unix)]
    #[test]
    fn finds_a_program_and_runs_it() {
        use std::os::unix::fs::PermissionsExt;
        let folder = tempfile::tempdir().unwrap();
        let program = folder.path().join("codex");
        std::fs::write(&program, "#!/bin/sh\necho \"$@\"; cat; exit 3\n").unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        // Not a program: not executable.
        std::fs::write(folder.path().join("claude"), "").unwrap();

        let path = joined_path(vec![folder.path().to_owned()]);
        assert_eq!(find_in("codex", &path), Some(program.clone()));
        assert_eq!(find_in("claude", &path), None);

        let mut command = Command::new(&program);
        command.args(["mcp", "list"]).stdin(Stdio::piped());
        let (ok, output) = finish(command, Some("read"), Duration::from_secs(10)).unwrap();
        assert!(!ok);
        assert!(output.contains("mcp list"));
        assert!(output.contains("read"));
    }
}
