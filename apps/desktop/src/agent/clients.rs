// Settings, Agents, Connect (docs/AUTOMATION.md): MagnetCut adds itself to
// Claude Code, Codex or OpenCode, each with a token of its own, by their own
// command lines. Claude Code gets the MagnetCut plugin from this repository's
// marketplace (plugins/magnetcut: the MCP server and a skill), Codex starts
// `magnetcut --mcp`, and OpenCode reaches the server by HTTP. OpenCode has no
// command to take a server out again, so Disconnect edits its config, its
// comments kept. Not in the App Store edition, whose sandbox runs no other
// program.

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
use serde::{Deserialize, Serialize};
use serde_json::json;

/// The marketplace Claude Code installs the plugin from: this repository, on
/// GitHub. MAGNETCUT_PLUGIN_MARKETPLACE names another (a folder, to try the
/// plugin before it's pushed).
const MARKETPLACE: &str = "magnetcut/magnetcut";
const MARKETPLACE_ENV: &str = "MAGNETCUT_PLUGIN_MARKETPLACE";
/// The marketplace's name, in its marketplace.json.
const MARKETPLACE_NAME: &str = "magnetcut";
const PLUGIN: &str = "magnetcut@magnetcut";
/// The server's name in each agent's config.
const SERVER: &str = "magnetcut";
/// How long one of their commands may take: Claude Code clones the marketplace.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(120);
/// How long the login shell may take to say its PATH.
const SHELL_TIMEOUT: Duration = Duration::from_secs(5);
/// How long a command's output may go on after it ends: a program it started
/// may hold the pipe.
const OUTPUT_TIMEOUT: Duration = Duration::from_secs(2);

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

/// One of their commands: its arguments, what it reads, and whether it may
/// fail (one that tidies up first, with nothing to tidy).
#[derive(Debug, PartialEq)]
pub struct Step {
    pub args: Vec<String>,
    pub input: Option<String>,
    pub may_fail: bool,
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

/// The commands that add MagnetCut to `client`, with its own token: `url` the
/// server's, `program` this app's, for `--mcp`.
pub fn connect_steps(
    client: Client,
    url: &str,
    token: &str,
    program: &Path,
    marketplace: &str,
) -> Vec<Step> {
    match client {
        Client::ClaudeCode => vec![
            // An entry pasted from Settings before: the plugin's now.
            tidy(&["mcp", "remove", SERVER, "--scope", "user"]),
            tidy(&["plugin", "marketplace", "add", marketplace]),
            tidy(&["plugin", "marketplace", "update", MARKETPLACE_NAME]),
            tidy(&["plugin", "uninstall", PLUGIN, "--scope", "user"]),
            step(&["plugin", "install", PLUGIN, "--scope", "user"]),
            // The token on standard input, not where other programs see it.
            Step {
                input: Some(json!({ "magnetcut_token": token, "magnetcut_url": url }).to_string()),
                ..step(&["plugin", "configure", PLUGIN, "--values-stdin"])
            },
        ],
        Client::Codex => vec![
            tidy(&["mcp", "remove", SERVER]),
            step(&[
                "mcp",
                "add",
                SERVER,
                "--env",
                &format!("MAGNETCUT_URL={url}"),
                "--env",
                &format!("MAGNETCUT_TOKEN={token}"),
                "--",
                &program.to_string_lossy(),
                "--mcp",
            ]),
        ],
        Client::OpenCode => vec![step(&[
            "mcp",
            "add",
            SERVER,
            "--url",
            url,
            "--header",
            &format!("Authorization=Bearer {token}"),
        ])],
    }
}

/// The commands that take MagnetCut out of `client`: none for OpenCode, whose
/// config is edited instead.
pub fn disconnect_steps(client: Client) -> Vec<Step> {
    match client {
        Client::ClaudeCode => vec![step(&["plugin", "uninstall", PLUGIN, "--scope", "user"])],
        Client::Codex => vec![step(&["mcp", "remove", SERVER])],
        Client::OpenCode => Vec::new(),
    }
}

/// Adds MagnetCut to `client`, with `token`. Says why not if it can't.
pub fn connect(client: Client, url: &str, token: &str, program: &Path) -> Result<(), String> {
    let found = find(client.program())
        .ok_or_else(|| format!("{} isn't installed on this computer", client.name()))?;
    if client == Client::OpenCode {
        remove_opencode_server()?;
    }
    let marketplace = std::env::var(MARKETPLACE_ENV).unwrap_or_else(|_| MARKETPLACE.into());
    run_steps(
        client,
        &found,
        &connect_steps(client, url, token, program, &marketplace),
    )
}

/// Takes MagnetCut out of `client`. Says why not if it can't.
pub fn disconnect(client: Client) -> Result<(), String> {
    if client == Client::OpenCode {
        return remove_opencode_server();
    }
    let found = find(client.program())
        .ok_or_else(|| format!("{} isn't installed on this computer", client.name()))?;
    run_steps(client, &found, &disconnect_steps(client))
}

fn run_steps(client: Client, program: &Path, steps: &[Step]) -> Result<(), String> {
    for step in steps {
        let (ok, output) = run(program, &step.args, step.input.as_deref())?;
        if !ok && !step.may_fail {
            let said = output.trim();
            return Err(if said.is_empty() {
                format!("{} said no to `{}`", client.name(), step.args.join(" "))
            } else {
                format!("{}: {said}", client.name())
            });
        }
    }
    Ok(())
}

/// Runs a program with what it reads, from a folder of no project's: whether
/// it worked, and what it said.
fn run(program: &Path, args: &[String], input: Option<&str>) -> Result<(bool, String), String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .env("PATH", search_path())
        .current_dir(std::env::temp_dir())
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        });
    let (ok, output) = finish(command, input, COMMAND_TIMEOUT)
        .ok_or_else(|| format!("{} didn't answer in time", program.display()))?;
    Ok((ok, output))
}

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
/// the login shell's (an app opened from the Finder has only the system's),
/// and where their installers put them. Found once.
fn search_path() -> &'static OsString {
    static PATH: OnceLock<OsString> = OnceLock::new();
    PATH.get_or_init(|| {
        let mut folders: Vec<PathBuf> = Vec::new();
        for path in [std::env::var_os("PATH"), login_shell_path()]
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

/// The login shell's PATH: what its profile adds (Homebrew's, nvm's).
#[cfg(unix)]
fn login_shell_path() -> Option<OsString> {
    let shell = std::env::var_os("SHELL").unwrap_or_else(|| "/bin/sh".into());
    let mut command = Command::new(shell);
    // `env` prints PATH joined by colons in any shell, fish's too.
    command.args(["-ilc", "/usr/bin/env"]).stdin(Stdio::null());
    let (_, output) = finish(command, None, SHELL_TIMEOUT)?;
    output
        .lines()
        .rev()
        .find_map(|line| line.strip_prefix("PATH="))
        .map(OsString::from)
}

#[cfg(not(unix))]
fn login_shell_path() -> Option<OsString> {
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

/// OpenCode's settings folder: $XDG_CONFIG_HOME/opencode, or
/// ~/.config/opencode, on every system.
fn opencode_folder() -> Option<PathBuf> {
    std::env::var_os("XDG_CONFIG_HOME")
        .filter(|folder| !folder.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::home_dir().map(|home| home.join(".config")))
        .map(|config| config.join("opencode"))
}

/// Takes MagnetCut's server out of OpenCode's settings, in either file.
fn remove_opencode_server() -> Result<(), String> {
    let Some(folder) = opencode_folder() else {
        return Ok(());
    };
    for name in ["opencode.json", "opencode.jsonc"] {
        let path = folder.join(name);
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let edited = without_server(&text).map_err(|error| {
            format!(
                "Couldn't read {}: take \"{SERVER}\" out of its \"mcp\" by hand ({error})",
                path.display()
            )
        })?;
        if let Some(edited) = edited {
            // Written whole, then moved into place: never half a file.
            let partial = path.with_extension("magnetcut-partial");
            std::fs::write(&partial, edited)
                .and_then(|()| std::fs::rename(&partial, &path))
                .map_err(|error| format!("Couldn't write {}: {error}", path.display()))?;
        }
    }
    Ok(())
}

/// OpenCode's settings without MagnetCut's server, everything else as it
/// was, comments included: None if it isn't there.
pub fn without_server(text: &str) -> Result<Option<String>, String> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opencode_keeps_everything_but_magnetcut() {
        let text = r#"{
  // My settings.
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "other": { "type": "local", "command": ["other"] },
    "magnetcut": {
      "type": "remote",
      "url": "http://127.0.0.1:47213/mcp",
      "headers": { "Authorization": "Bearer mc_x" }
    },
  },
  "theme": "dark"
}
"#;
        let edited = without_server(text).unwrap().unwrap();
        assert!(edited.contains("// My settings."));
        assert!(edited.contains(r#""other": { "type": "local", "command": ["other"] }"#));
        assert!(edited.contains(r#""theme": "dark""#));
        assert!(!edited.contains("magnetcut"));
        assert!(!edited.contains("mc_x"));
        // Still settings OpenCode reads.
        assert!(CstRootNode::parse(&edited, &ParseOptions::default()).is_ok());
    }

    #[test]
    fn opencode_without_magnetcut_is_left_alone() {
        assert_eq!(without_server(r#"{ "mcp": { "other": {} } }"#), Ok(None));
        assert_eq!(without_server(r#"{ "theme": "dark" }"#), Ok(None));
        assert!(without_server("{ not json").is_err());
    }

    #[test]
    fn claude_code_gets_the_plugin_with_its_token_on_standard_input() {
        let steps = connect_steps(
            Client::ClaudeCode,
            "http://127.0.0.1:47213/mcp",
            "mc_secret",
            Path::new("/Applications/MagnetCut.app/Contents/MacOS/magnetcut"),
            MARKETPLACE,
        );
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
        assert_eq!(values["magnetcut_url"], "http://127.0.0.1:47213/mcp");
        // Nowhere on a command line.
        assert!(
            steps
                .iter()
                .all(|step| step.args.iter().all(|arg| !arg.contains("mc_secret")))
        );
    }

    #[test]
    fn codex_starts_magnetcut_with_its_token() {
        let steps = connect_steps(
            Client::Codex,
            "http://127.0.0.1:47213/mcp",
            "mc_secret",
            Path::new("/bin/magnetcut"),
            MARKETPLACE,
        );
        assert_eq!(steps.len(), 2);
        assert!(steps[0].may_fail);
        assert_eq!(
            steps[1].args,
            [
                "mcp",
                "add",
                "magnetcut",
                "--env",
                "MAGNETCUT_URL=http://127.0.0.1:47213/mcp",
                "--env",
                "MAGNETCUT_TOKEN=mc_secret",
                "--",
                "/bin/magnetcut",
                "--mcp"
            ]
        );
        assert_eq!(
            disconnect_steps(Client::Codex)[0].args,
            ["mcp", "remove", "magnetcut"]
        );
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
        let folder = std::env::temp_dir().join(format!("magnetcut-clients-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        let program = folder.join("codex");
        std::fs::write(&program, "#!/bin/sh\necho \"$@\"; cat; exit 3\n").unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        // Not a program: not executable.
        std::fs::write(folder.join("claude"), "").unwrap();

        let path = joined_path(vec![folder.clone()]);
        assert_eq!(find_in("codex", &path), Some(program.clone()));
        assert_eq!(find_in("claude", &path), None);

        let mut command = Command::new(&program);
        command.args(["mcp", "list"]).stdin(Stdio::piped());
        let (ok, output) = finish(command, Some("read"), Duration::from_secs(10)).unwrap();
        assert!(!ok);
        assert!(output.contains("mcp list"));
        assert!(output.contains("read"));
        std::fs::remove_dir_all(&folder).unwrap();
    }
}
