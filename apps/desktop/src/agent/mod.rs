// Agents steering the app (docs/AUTOMATION.md): MCP served on 127.0.0.1, to
// the agents the user added in Settings, each with its own token. Each tool
// call goes to the editor, which does the work, and its answer comes back
// (`agent_reply`). A path an agent names is opened for the editor only if
// it's in that agent's call, while the call is on: revoking the agent,
// switching agent mode off, the call timing out or the editor's page going
// end it.

pub mod cli;
pub mod clients;
mod http;
mod mcp;
mod scope;
mod tokens;

use std::collections::HashMap;
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::export::Exports;
use crate::media::{DiskFileInfo, MediaFiles};
use tokens::Store;

/// What a call's editor side sends back: progress, then the result.
pub enum Update {
    Progress {
        progress: f64,
        total: Option<f64>,
        message: Option<String>,
    },
    Done(Value),
}

/// A tool call, as the editor gets it.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub call: u64,
    pub tool: String,
    pub arguments: Value,
    pub agent: String,
}

/// What the editor is sent.
pub enum ToEditor<'a> {
    /// A call to make.
    Call(&'a ToolCall),
    /// Calls no one waits for any more (timed out, the agent revoked, agent
    /// mode switched off): dropped if they haven't started, stopped if they
    /// have.
    Cancel(&'a [u64]),
}

/// The agent a request is from: its id in the store, and its name.
#[derive(Clone)]
struct Caller {
    id: String,
    name: String,
}

struct Call {
    agent: Caller,
    arguments: Value,
    /// Paths the call reached through a file the agent named: a project
    /// file's media.
    allowed: Vec<String>,
    updates: Sender<Update>,
}

struct Server {
    port: u16,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

type Editor = Box<dyn Fn(ToEditor<'_>) -> Result<(), String> + Send + Sync>;

pub struct Shared {
    store_path: PathBuf,
    store: Mutex<Store>,
    server: Mutex<Option<Server>>,
    tools: Mutex<Option<Value>>,
    tools_ready: Condvar,
    calls: Mutex<HashMap<u64, Call>>,
    next_call: AtomicU64,
    editor: Editor,
    version: String,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

// The port served on first, if it's free: the command line's default.
const DEFAULT_PORT: u16 = 47213;

// How often an agent's last use is written down.
const LAST_USED_EVERY: u64 = 60;

impl Shared {
    /// The agent `token` is for, if it's one of the user's.
    fn agent_for(&self, token: &str) -> Option<Caller> {
        let store = lock(&self.store);
        let agent = &store.agents[store.position(token)?];
        Some(Caller {
            id: agent.id.clone(),
            name: agent.name.clone(),
        })
    }

    /// Notes that agent `id` made a request, now and then.
    fn note_use(&self, id: &str) {
        let mut store = lock(&self.store);
        let now = tokens::now();
        let Some(agent) = store.agents.iter_mut().find(|agent| agent.id == id) else {
            return;
        };
        if agent
            .last_used
            .is_none_or(|last| now >= last + LAST_USED_EVERY)
        {
            agent.last_used = Some(now);
            let _ = store.save(&self.store_path);
        }
    }

    /// The editor's tools once it has said them, waiting up to `timeout`:
    /// none if it hasn't, or its page is reloading.
    fn ready(&self, timeout: Duration) -> MutexGuard<'_, Option<Value>> {
        let tools = lock(&self.tools);
        self.tools_ready
            .wait_timeout_while(tools, timeout, |tools| tools.is_none())
            .unwrap_or_else(|e| e.into_inner())
            .0
    }

    fn tools(&self, timeout: Duration) -> Option<Value> {
        self.ready(timeout).clone()
    }

    /// Hands a call to the editor, once it listens (waiting up to `wait`):
    /// its number, and where its updates come.
    fn start_call(
        &self,
        agent: &Caller,
        tool: &str,
        arguments: Value,
        wait: Duration,
    ) -> Result<(u64, Receiver<Update>), String> {
        // Sent before the page listens, or as it reloads, a call would be
        // lost. Held while it's sent: a page that goes drops its tools, then
        // the calls it had (`editor_gone`).
        let ready = self.ready(wait);
        if ready.is_none() {
            return Err("The editor isn't ready: try again".into());
        }
        let number = self.next_call.fetch_add(1, Ordering::Relaxed) + 1;
        let (updates, receiver) = mpsc::channel();
        {
            let mut calls = lock(&self.calls);
            // Revoked or switched off since the request was let in: then
            // either this sees it, or the call is ended with the others.
            let store = lock(&self.store);
            if !store.enabled || !store.agents.iter().any(|known| known.id == agent.id) {
                return Err(format!("{} may no longer use MagnetCut", agent.name));
            }
            drop(store);
            calls.insert(
                number,
                Call {
                    agent: agent.clone(),
                    arguments: arguments.clone(),
                    allowed: Vec::new(),
                    updates,
                },
            );
        }
        let call = ToolCall {
            call: number,
            tool: tool.to_owned(),
            arguments,
            agent: agent.name.clone(),
        };
        if let Err(message) = (self.editor)(ToEditor::Call(&call)) {
            self.end_call(number);
            return Err(message);
        }
        drop(ready);
        Ok((number, receiver))
    }

    fn end_call(&self, number: u64) {
        lock(&self.calls).remove(&number);
    }

    /// Ends the calls `which` picks, each answered with `message`, and tells
    /// the editor to drop them: their paths no longer open anything.
    fn end_calls(&self, which: impl Fn(u64, &Call) -> bool, message: &str) {
        let ended: Vec<(u64, Call)> = lock(&self.calls)
            .extract_if(|number, call| which(*number, call))
            .collect();
        if ended.is_empty() {
            return;
        }
        for (_, call) in &ended {
            let _ = call.updates.send(Update::Done(mcp::failed(message)));
        }
        let numbers: Vec<u64> = ended.iter().map(|(number, _)| *number).collect();
        let _ = (self.editor)(ToEditor::Cancel(&numbers));
    }

    /// Ends call `number`, which the agent was told didn't answer in time: not
    /// to be done later, when the agent may have tried again.
    fn cancel(&self, number: u64) {
        self.end_calls(|each, _| each == number, "The editor didn't answer in time");
    }

    /// The editor's page is gone (reloading, or closed): its tools, until the
    /// next one says them, and the calls it had, which it won't answer.
    fn editor_gone(&self) {
        *lock(&self.tools) = None;
        self.end_calls(
            |_, _| true,
            "The editor's window reloaded or closed before it answered: call again",
        );
    }

    /// The agents MagnetCut added itself to `client` as, those `keep` says.
    fn ids_for(&self, client: clients::Client, keep: impl Fn(&str) -> bool) -> Vec<String> {
        lock(&self.store)
            .agents
            .iter()
            .filter(|agent| agent.client == Some(client) && keep(&agent.id))
            .map(|agent| agent.id.clone())
            .collect()
    }

    /// Takes an agent out at once, its calls too, even if the store can't be
    /// saved.
    fn revoke(&self, id: &str) -> Result<(), String> {
        let saved = {
            let mut store = lock(&self.store);
            store.revoke(id);
            store.save(&self.store_path)
        };
        self.end_calls(|_, call| call.agent.id == id, "The user revoked this agent");
        saved
    }

    /// Agent mode on, served; or off, the port closed and every call ended,
    /// even if the store can't be saved.
    fn set_enabled(self: &Arc<Self>, enabled: bool) -> Result<(), String> {
        let saved = {
            let mut store = lock(&self.store);
            store.enabled = enabled;
            store.save(&self.store_path)
        };
        if enabled {
            self.start()?;
        } else {
            self.stop();
        }
        saved
    }

    fn update(&self, number: u64, update: Update) {
        let done = matches!(update, Update::Done(_));
        let calls = lock(&self.calls);
        if let Some(call) = calls.get(&number) {
            let _ = call.updates.send(update);
        }
        drop(calls);
        if done {
            self.end_call(number);
        }
    }

    /// Whether `path` is one the agent named in call `number`, or reached
    /// through a file it named: never once the call's over.
    fn named(&self, number: u64, path: &str) -> bool {
        lock(&self.calls).get(&number).is_some_and(|call| {
            mentions(&call.arguments, path) || call.allowed.iter().any(|one| one == path)
        })
    }

    /// The name of the agent making call `number`.
    fn agent_of(&self, number: u64) -> String {
        lock(&self.calls)
            .get(&number)
            .map_or_else(|| "An agent".to_owned(), |call| call.agent.name.clone())
    }

    /// Whether call `number` is still on: not answered, timed out, revoked or
    /// switched off.
    fn is_live(&self, number: u64) -> bool {
        lock(&self.calls).contains_key(&number)
    }

    /// Lets call `number` open `paths` too.
    fn allow(&self, number: u64, paths: Vec<String>) {
        if let Some(call) = lock(&self.calls).get_mut(&number) {
            call.allowed.extend(paths);
        }
    }

    /// Serves, on the port kept (or, while that's taken, on another free one,
    /// not kept: the lines pasted name the one kept).
    fn start(self: &Arc<Self>) -> Result<u16, String> {
        let mut server = lock(&self.server);
        if let Some(running) = server.as_ref() {
            return Ok(running.port);
        }
        let kept = lock(&self.store).port;
        // The port the command line's MAGNETCUT_URL takes by default, unless
        // another was kept.
        let wanted = if kept == 0 { DEFAULT_PORT } else { kept };
        let listener = TcpListener::bind(("127.0.0.1", wanted))
            .or_else(|_| TcpListener::bind(("127.0.0.1", 0)))
            .map_err(|error| format!("Couldn't serve agents: {error}"))?;
        let port = listener
            .local_addr()
            .map_err(|error| error.to_string())?
            .port();
        if port == wanted && port != kept {
            let mut store = lock(&self.store);
            store.port = port;
            store.save(&self.store_path)?;
        }
        let stop = Arc::new(AtomicBool::new(false));
        let shared = Arc::clone(self);
        let stopping = Arc::clone(&stop);
        let thread = thread::Builder::new()
            .name("agents".into())
            .spawn(move || {
                for stream in listener.incoming() {
                    if stopping.load(Ordering::Relaxed) {
                        break;
                    }
                    let Ok(stream) = stream else { continue };
                    let shared = Arc::clone(&shared);
                    let _ = thread::Builder::new()
                        .name("agent request".into())
                        .spawn(move || mcp::handle(&shared, &stream, port));
                }
            })
            .map_err(|error| error.to_string())?;
        *server = Some(Server {
            port,
            stop,
            thread: Some(thread),
        });
        Ok(port)
    }

    /// The port closed, and the calls on their way ended.
    fn stop(&self) {
        let taken = lock(&self.server).take();
        if let Some(mut server) = taken {
            server.stop.store(true, Ordering::Relaxed);
            // Wakes the listener, which then sees it's stopped.
            let _ = TcpStream::connect(("127.0.0.1", server.port));
            if let Some(thread) = server.thread.take() {
                let _ = thread.join();
            }
        }
        self.end_calls(|_, _| true, "The user switched agent mode off");
    }

    fn running_port(&self) -> Option<u16> {
        lock(&self.server).as_ref().map(|server| server.port)
    }
}

/// Whether `text` is one of the strings in `value`, at any depth.
fn mentions(value: &Value, text: &str) -> bool {
    match value {
        Value::String(string) => string == text,
        Value::Array(items) => items.iter().any(|item| mentions(item, text)),
        Value::Object(fields) => fields.values().any(|field| mentions(field, text)),
        _ => false,
    }
}

// For the app's own end-to-end test (.github/workflows/probe.yml): agent mode
// on with this token, on this port, in a store of its own, the user's agents
// left alone. Whoever can set these can run programs as the user already.
const TEST_TOKEN: &str = "MAGNETCUT_AGENT_TEST_TOKEN";
const TEST_PORT: &str = "MAGNETCUT_AGENT_TEST_PORT";

/// Whether the app runs for that test, which is the only one it runs.
pub fn is_test() -> bool {
    std::env::var_os(TEST_TOKEN).is_some()
}

/// The test's store, written afresh, if the test asked for one.
fn test_store() -> Option<PathBuf> {
    let token = std::env::var(TEST_TOKEN).ok()?;
    let port = std::env::var(TEST_PORT).ok()?.parse().ok()?;
    let path = tokens::location(std::env::temp_dir().join("magnetcut-agent-test"));
    let store = Store {
        enabled: true,
        port,
        agents: vec![tokens::Agent {
            id: "test".into(),
            name: "Test agent".into(),
            hash: tokens::hash(&token),
            created: tokens::now(),
            last_used: None,
            client: None,
        }],
        folders: Vec::new(),
    };
    store.save(&path).ok()?;
    Some(path)
}

/// Agent mode: the store, the server and the calls on their way.
pub struct Agents(Arc<Shared>);

impl Agents {
    fn new(store_path: PathBuf, version: String, editor: Editor) -> Self {
        Self(Arc::new(Shared {
            store: Mutex::new(Store::load(&store_path)),
            store_path,
            server: Mutex::new(None),
            tools: Mutex::new(None),
            tools_ready: Condvar::new(),
            calls: Mutex::new(HashMap::new()),
            next_call: AtomicU64::new(0),
            editor,
            version,
        }))
    }

    /// Agent mode as the user left it: served at once if it's on.
    pub fn load(app: &AppHandle) -> Self {
        let data = app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| std::env::temp_dir().join("magnetcut"));
        let handle = app.clone();
        let store_path = match test_store() {
            Some(path) => path,
            None => tokens::location(data),
        };
        let agents = Self::new(
            store_path,
            app.package_info().version.to_string(),
            Box::new(move |message| {
                match message {
                    ToEditor::Call(call) => handle.emit_to("main", "agent", call),
                    ToEditor::Cancel(calls) => handle.emit_to("main", "agent-cancel", calls),
                }
                .map_err(|error| format!("Couldn't reach the editor: {error}"))
            }),
        );
        // The folders granted, reachable again in the sandbox.
        for folder in &lock(&agents.0.store).folders {
            if let Some(bookmark) = folder.bookmark.as_ref().and_then(|b| BASE64.decode(b).ok()) {
                scope::open(&bookmark);
            }
        }
        if lock(&agents.0.store).enabled
            && let Err(error) = agents.0.start()
        {
            eprintln!("agents: {error}");
        }
        agents
    }

    /// The editor's page is gone, reloading or closed: the calls it had are
    /// ended, and the next ones wait for the page to listen again.
    pub fn editor_gone(&self) {
        self.0.editor_gone();
    }

    fn settings(&self) -> Settings {
        let store = lock(&self.0.store);
        let port = self.0.running_port();
        Settings {
            enabled: store.enabled,
            port: port.or((store.port != 0).then_some(store.port)),
            running: port.is_some(),
            url: port.map(|port| format!("http://127.0.0.1:{port}/mcp")),
            sandboxed: !cfg!(feature = "updater"),
            program: std::env::current_exe()
                .ok()
                .and_then(|path| path.to_str().map(str::to_owned)),
            folders: store
                .folders
                .iter()
                .map(|folder| folder.path.clone())
                .collect(),
            agents: store
                .agents
                .iter()
                .map(|agent| AgentView {
                    id: agent.id.clone(),
                    name: agent.name.clone(),
                    created: agent.created,
                    last_used: agent.last_used,
                    client: agent.client,
                })
                .collect(),
        }
    }
}

impl Drop for Agents {
    fn drop(&mut self) {
        self.0.stop();
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentView {
    id: String,
    name: String,
    created: u64,
    last_used: Option<u64>,
    client: Option<clients::Client>,
}

/// What Settings shows.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    enabled: bool,
    port: Option<u16>,
    running: bool,
    url: Option<String>,
    /// The App Store edition: files only as its sandbox allows.
    sandboxed: bool,
    /// The app's own program, for the command line's `--mcp`.
    program: Option<String>,
    /// Folders agents may use, in the App Store edition.
    folders: Vec<String>,
    agents: Vec<AgentView>,
}

/// An agent just added: its token, shown this once.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Added {
    id: String,
    token: String,
    settings: Settings,
}

#[tauri::command]
pub fn agent_settings(agents: State<'_, Agents>) -> Settings {
    agents.settings()
}

/// Agent mode on or off: served, or not.
#[tauri::command]
pub fn agent_set_enabled(agents: State<'_, Agents>, enabled: bool) -> Result<Settings, String> {
    agents.0.set_enabled(enabled)?;
    Ok(agents.settings())
}

#[tauri::command]
pub fn agent_add(agents: State<'_, Agents>, name: String) -> Result<Added, String> {
    let (agent, token) = {
        let mut store = lock(&agents.0.store);
        let added = store.add(&name, None)?;
        store.save(&agents.0.store_path)?;
        added
    };
    Ok(Added {
        id: agent.id,
        token,
        settings: agents.settings(),
    })
}

/// Revokes an agent: its token no longer lets it in, and its calls on their
/// way end.
#[tauri::command]
pub fn agent_revoke(agents: State<'_, Agents>, id: String) -> Result<Settings, String> {
    agents.0.revoke(&id)?;
    Ok(agents.settings())
}

/// Claude Code, Codex and OpenCode, and which are on this computer: looked
/// for in the login shell's PATH too, which takes a moment.
#[tauri::command]
pub async fn agent_clients() -> Vec<clients::ClientView> {
    tauri::async_runtime::spawn_blocking(clients::detect)
        .await
        .unwrap_or_default()
}

/// Adds MagnetCut to one of them, with a token of its own, in place of the
/// one it had: the old token goes once the new one is in.
#[tauri::command]
pub async fn agent_connect(
    agents: State<'_, Agents>,
    client: clients::Client,
) -> Result<Settings, String> {
    if !cfg!(feature = "updater") {
        return Err("In this edition, paste the lines for your agent instead".into());
    }
    let url = agents
        .0
        .running_port()
        .map(|port| format!("http://127.0.0.1:{port}/mcp"))
        .ok_or("Let agents use MagnetCut first")?;
    let program = std::env::current_exe().map_err(|error| error.to_string())?;
    let (agent, token) = {
        let mut store = lock(&agents.0.store);
        let added = store.add(client.name(), Some(client))?;
        store.save(&agents.0.store_path)?;
        added
    };
    let connected = tauri::async_runtime::spawn_blocking(move || {
        clients::connect(client, &url, &token, &program)
    })
    .await
    .map_err(|error| error.to_string())
    .and_then(|result| result);
    let replaced = match connected {
        Ok(()) => agents.0.ids_for(client, |id| id != agent.id),
        Err(error) => {
            agents.0.revoke(&agent.id)?;
            return Err(error);
        }
    };
    for id in replaced {
        agents.0.revoke(&id)?;
    }
    Ok(agents.settings())
}

/// Takes MagnetCut out of one of them; its token goes whatever happens, so
/// what's left lets nothing in.
#[tauri::command]
pub async fn agent_disconnect(
    agents: State<'_, Agents>,
    client: clients::Client,
) -> Result<Settings, String> {
    let disconnected = tauri::async_runtime::spawn_blocking(move || clients::disconnect(client))
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result);
    for id in agents.0.ids_for(client, |_| true) {
        agents.0.revoke(&id)?;
    }
    disconnected.map(|()| agents.settings())
}

/// The editor's tools, as MCP lists them: said once the editor is ready.
#[tauri::command]
pub fn agent_register_tools(agents: State<'_, Agents>, tools: Value) {
    *lock(&agents.0.tools) = Some(tools);
    agents.0.tools_ready.notify_all();
}

/// A call's result, from the editor: MCP's `CallToolResult`.
#[tauri::command]
pub fn agent_reply(agents: State<'_, Agents>, call: u64, result: Value) {
    agents.0.update(call, Update::Done(result));
}

#[tauri::command]
pub fn agent_progress(
    agents: State<'_, Agents>,
    call: u64,
    progress: f64,
    total: Option<f64>,
    message: Option<String>,
) {
    agents.0.update(
        call,
        Update::Progress {
            progress,
            total,
            message,
        },
    );
}

/// A path the agent named in call `call`, checked: whole, and in the call.
fn agent_path(agents: &Agents, call: u64, path: &str) -> Result<PathBuf, String> {
    if !agents.0.named(call, path) {
        return Err(format!("{path} isn't a path this call named"));
    }
    let location = PathBuf::from(path);
    if !location.is_absolute() {
        return Err(format!("{path} isn't a whole path: give it from the root"));
    }
    Ok(location)
}

/// That call `call` is still on, after a dialog it may have waited on: one
/// revoked or switched off meanwhile opens and writes nothing.
fn still_live(agents: &Agents, call: u64) -> Result<(), String> {
    if agents.0.is_live(call) {
        Ok(())
    } else {
        Err("This call was ended".into())
    }
}

/// Whether the app can reach `location` as it stands: in the App Store
/// edition, only inside what the sandbox allows.
fn can_reach(location: &Path, write: bool) -> bool {
    let target = if write {
        location.parent().unwrap_or(location)
    } else {
        location
    };
    std::fs::metadata(target).is_ok()
}

/// A path the agent named, reachable: as it is, or, in the App Store edition
/// where the sandbox keeps it out, as the user picks it in the window's open
/// or save dialog, put at that path.
async fn reach(
    app: &AppHandle,
    agents: &Agents,
    call: u64,
    location: PathBuf,
    write: bool,
) -> Result<PathBuf, String> {
    if !agents.settings().sandboxed || can_reach(&location, write) {
        return Ok(location);
    }
    let agent = agents.0.agent_of(call);
    let mut dialog = app.dialog().file().set_title(format!(
        "{agent} wants to {} this file",
        if write { "save" } else { "open" }
    ));
    if let Some(folder) = location.parent() {
        dialog = dialog.set_directory(folder);
    }
    if let Some(name) = location.file_name().and_then(|name| name.to_str()) {
        dialog = dialog.set_file_name(name);
    }
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    let picked = tauri::async_runtime::spawn_blocking(move || {
        if write {
            dialog.blocking_save_file()
        } else {
            dialog.blocking_pick_file()
        }
    })
    .await
    .map_err(|error| error.to_string())?;
    picked
        .and_then(|file| file.into_path().ok())
        .ok_or_else(|| format!("The user didn't let {agent} reach {}", location.display()))
}

/// Opens a media file an agent named for the editor to read, as if dropped.
#[tauri::command]
pub async fn agent_open_media(
    app: AppHandle,
    agents: State<'_, Agents>,
    media: State<'_, MediaFiles>,
    call: u64,
    path: String,
) -> Result<DiskFileInfo, String> {
    let location = reach(
        &app,
        &agents,
        call,
        agent_path(&agents, call, &path)?,
        false,
    )
    .await?;
    still_live(&agents, call)?;
    if !location.is_file() {
        return Err(unreachable(&location, agents.settings().sandboxed));
    }
    media
        .grant(vec![location])
        .pop()
        .ok_or_else(|| format!("{path} isn't a film, a picture or a sound MagnetCut opens"))
}

/// Lets the editor export to a file an agent named, as if picked in the save
/// dialog; never over one that's there unless the agent said so: the path
/// it's written to.
#[tauri::command]
pub async fn agent_export_to(
    app: AppHandle,
    agents: State<'_, Agents>,
    exports: State<'_, Exports>,
    call: u64,
    path: String,
    replace: bool,
) -> Result<String, String> {
    let named = agent_path(&agents, call, &path)?;
    if named.exists() && !replace {
        return Err(format!(
            "{path} is there already: say `replace` to write over it"
        ));
    }
    if !named.parent().is_some_and(Path::is_dir) && !agents.settings().sandboxed {
        return Err(format!("{path}'s folder isn't there"));
    }
    let location = reach(&app, &agents, call, named, true).await?;
    still_live(&agents, call)?;
    let shown = location
        .to_str()
        .map(str::to_owned)
        .ok_or("not a UTF-8 path")?;
    exports.add_pick(location);
    Ok(shown)
}

/// The media paths in a project file: what opening it needs to read.
pub fn media_paths(text: &str) -> Vec<String> {
    let Ok(file) = serde_json::from_str::<Value>(text) else {
        return Vec::new();
    };
    file.get("media")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|medium| medium.get("path").and_then(Value::as_str))
        .map(str::to_owned)
        .collect()
}

/// A project file an agent named, read for the editor, which may then open
/// the media in it.
#[tauri::command]
pub async fn agent_read_project(
    app: AppHandle,
    agents: State<'_, Agents>,
    call: u64,
    path: String,
) -> Result<String, String> {
    let location = reach(
        &app,
        &agents,
        call,
        agent_path(&agents, call, &path)?,
        false,
    )
    .await?;
    still_live(&agents, call)?;
    let text = std::fs::read_to_string(&location)
        .map_err(|_| unreachable(&location, agents.settings().sandboxed))?;
    agents.0.allow(call, media_paths(&text));
    Ok(text)
}

/// A project file an agent named, written from the editor; never over one
/// that's there unless the agent said so: the path it's written to.
#[tauri::command]
pub async fn agent_write_project(
    app: AppHandle,
    agents: State<'_, Agents>,
    call: u64,
    path: String,
    text: String,
    replace: bool,
) -> Result<String, String> {
    let named = agent_path(&agents, call, &path)?;
    if named.exists() && !replace {
        return Err(format!(
            "{path} is there already: say `replace` to write over it"
        ));
    }
    let location = reach(&app, &agents, call, named, true).await?;
    still_live(&agents, call)?;
    std::fs::write(&location, text).map_err(|error| format!("Couldn't write {path}: {error}"))?;
    location
        .to_str()
        .map(str::to_owned)
        .ok_or_else(|| "not a UTF-8 path".into())
}

/// Adds a folder agents may use, picked in the open dialog, kept with a
/// bookmark: the App Store edition's way past its sandbox.
#[tauri::command]
pub async fn agent_add_folder(
    app: AppHandle,
    agents: State<'_, Agents>,
) -> Result<Settings, String> {
    let mut dialog = app.dialog().file().set_title("A folder agents may use");
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_folder())
        .await
        .map_err(|error| error.to_string())?;
    let Some(folder) = picked.and_then(|file| file.into_path().ok()) else {
        return Ok(agents.settings());
    };
    let path = folder
        .to_str()
        .map(str::to_owned)
        .ok_or("not a UTF-8 path")?;
    let bookmark = scope::create(&folder).map(|bookmark| BASE64.encode(bookmark));
    {
        let mut store = lock(&agents.0.store);
        store.folders.retain(|kept| kept.path != path);
        store.folders.push(tokens::Folder { path, bookmark });
        store.save(&agents.0.store_path)?;
    }
    Ok(agents.settings())
}

#[tauri::command]
pub fn agent_remove_folder(agents: State<'_, Agents>, path: String) -> Result<Settings, String> {
    {
        let mut store = lock(&agents.0.store);
        store.folders.retain(|kept| kept.path != path);
        store.save(&agents.0.store_path)?;
    }
    Ok(agents.settings())
}

/// Why a file can't be reached: in the App Store edition, most likely the
/// sandbox.
fn unreachable(location: &Path, sandboxed: bool) -> String {
    let shown = location.display();
    if sandboxed && location.exists() {
        format!(
            "{shown} is outside what the App Store edition may open: Movies, Downloads and the \
             folders granted in Settings"
        )
    } else {
        format!("{shown} isn't there")
    }
}

#[cfg(test)]
mod tests;
