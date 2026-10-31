// Agents steering the app (docs/AUTOMATION.md): MCP served on 127.0.0.1, to
// the agents the user added in Settings, each with its own token. Each tool
// call goes to the editor, which does the work, and its answer comes back
// (`agent_reply`). A path an agent names is opened for the editor only if
// it's in that agent's call.

mod http;
mod mcp;
mod tokens;

use std::collections::HashMap;
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

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

struct Call {
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

type Editor = Box<dyn Fn(&ToolCall) -> Result<(), String> + Send + Sync>;

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

// How often an agent's last use is written down.
const LAST_USED_EVERY: u64 = 60;

impl Shared {
    /// The name of the agent `token` is for, noting its use.
    fn agent_for(&self, token: &str) -> Option<String> {
        let mut store = lock(&self.store);
        let now = tokens::now();
        let index = store.position(token)?;
        let agent = &mut store.agents[index];
        let name = agent.name.clone();
        if agent
            .last_used
            .is_none_or(|last| now >= last + LAST_USED_EVERY)
        {
            agent.last_used = Some(now);
            let _ = store.save(&self.store_path);
        }
        Some(name)
    }

    /// The editor's tools, waiting up to `timeout` for it to say them.
    fn tools(&self, timeout: Duration) -> Option<Value> {
        let tools = lock(&self.tools);
        let (tools, _) = self
            .tools_ready
            .wait_timeout_while(tools, timeout, |tools| tools.is_none())
            .unwrap_or_else(|e| e.into_inner());
        tools.clone()
    }

    /// Hands a call to the editor: its number, and where its updates come.
    fn start_call(
        &self,
        agent: &str,
        tool: &str,
        arguments: Value,
    ) -> Result<(u64, Receiver<Update>), String> {
        let number = self.next_call.fetch_add(1, Ordering::Relaxed) + 1;
        let (updates, receiver) = mpsc::channel();
        lock(&self.calls).insert(
            number,
            Call {
                arguments: arguments.clone(),
                allowed: Vec::new(),
                updates,
            },
        );
        let call = ToolCall {
            call: number,
            tool: tool.to_owned(),
            arguments,
            agent: agent.to_owned(),
        };
        if let Err(message) = (self.editor)(&call) {
            self.end_call(number);
            return Err(message);
        }
        Ok((number, receiver))
    }

    fn end_call(&self, number: u64) {
        lock(&self.calls).remove(&number);
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
    /// through a file it named.
    fn named(&self, number: u64, path: &str) -> bool {
        lock(&self.calls).get(&number).is_some_and(|call| {
            mentions(&call.arguments, path) || call.allowed.iter().any(|one| one == path)
        })
    }

    /// Lets call `number` open `paths` too.
    fn allow(&self, number: u64, paths: Vec<String>) {
        if let Some(call) = lock(&self.calls).get_mut(&number) {
            call.allowed.extend(paths);
        }
    }

    /// Serves, on the port kept (or another free one, then kept).
    fn start(self: &Arc<Self>) -> Result<u16, String> {
        let mut server = lock(&self.server);
        if let Some(running) = server.as_ref() {
            return Ok(running.port);
        }
        let kept = lock(&self.store).port;
        let listener = TcpListener::bind(("127.0.0.1", kept))
            .or_else(|_| TcpListener::bind(("127.0.0.1", 0)))
            .map_err(|error| format!("Couldn't serve agents: {error}"))?;
        let port = listener
            .local_addr()
            .map_err(|error| error.to_string())?
            .port();
        if port != kept {
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

    fn stop(&self) {
        let Some(mut server) = lock(&self.server).take() else {
            return;
        };
        server.stop.store(true, Ordering::Relaxed);
        // Wakes the listener, which then sees it's stopped.
        let _ = TcpStream::connect(("127.0.0.1", server.port));
        if let Some(thread) = server.thread.take() {
            let _ = thread.join();
        }
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
        }],
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
            Box::new(move |call| {
                handle
                    .emit_to("main", "agent", call)
                    .map_err(|error| format!("Couldn't reach the editor: {error}"))
            }),
        );
        if lock(&agents.0.store).enabled
            && let Err(error) = agents.0.start()
        {
            eprintln!("agents: {error}");
        }
        agents
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
            agents: store
                .agents
                .iter()
                .map(|agent| AgentView {
                    id: agent.id.clone(),
                    name: agent.name.clone(),
                    created: agent.created,
                    last_used: agent.last_used,
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
    {
        let mut store = lock(&agents.0.store);
        store.enabled = enabled;
        store.save(&agents.0.store_path)?;
    }
    if enabled {
        agents.0.start()?;
    } else {
        agents.0.stop();
    }
    Ok(agents.settings())
}

#[tauri::command]
pub fn agent_add(agents: State<'_, Agents>, name: String) -> Result<Added, String> {
    let (agent, token) = {
        let mut store = lock(&agents.0.store);
        let added = store.add(&name)?;
        store.save(&agents.0.store_path)?;
        added
    };
    Ok(Added {
        id: agent.id,
        token,
        settings: agents.settings(),
    })
}

#[tauri::command]
pub fn agent_revoke(agents: State<'_, Agents>, id: String) -> Result<Settings, String> {
    {
        let mut store = lock(&agents.0.store);
        store.revoke(&id);
        store.save(&agents.0.store_path)?;
    }
    Ok(agents.settings())
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

/// Opens a media file an agent named for the editor to read, as if dropped.
#[tauri::command]
pub fn agent_open_media(
    agents: State<'_, Agents>,
    media: State<'_, MediaFiles>,
    call: u64,
    path: String,
) -> Result<DiskFileInfo, String> {
    let location = agent_path(&agents, call, &path)?;
    if !location.is_file() {
        return Err(unreachable(&location, agents.settings().sandboxed));
    }
    media
        .grant(vec![location])
        .pop()
        .ok_or_else(|| format!("{path} isn't a film, a picture or a sound MagnetCut opens"))
}

/// Lets the editor export to a file an agent named, as if picked in the save
/// dialog; never over one that's there unless the agent said so.
#[tauri::command]
pub fn agent_export_to(
    agents: State<'_, Agents>,
    exports: State<'_, Exports>,
    call: u64,
    path: String,
    replace: bool,
) -> Result<(), String> {
    let location = agent_path(&agents, call, &path)?;
    if location.exists() && !replace {
        return Err(format!(
            "{path} is there already: say `replace` to write over it"
        ));
    }
    if !location.parent().is_some_and(Path::is_dir) {
        return Err(format!("{path}'s folder isn't there"));
    }
    exports.add_pick(location);
    Ok(())
}

/// The media paths in a project file: what opening it needs to read.
fn media_paths(text: &str) -> Vec<String> {
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
pub fn agent_read_project(
    agents: State<'_, Agents>,
    call: u64,
    path: String,
) -> Result<String, String> {
    let location = agent_path(&agents, call, &path)?;
    let text = std::fs::read_to_string(&location)
        .map_err(|_| unreachable(&location, agents.settings().sandboxed))?;
    agents.0.allow(call, media_paths(&text));
    Ok(text)
}

/// A project file an agent named, written from the editor; never over one
/// that's there unless the agent said so.
#[tauri::command]
pub fn agent_write_project(
    agents: State<'_, Agents>,
    call: u64,
    path: String,
    text: String,
    replace: bool,
) -> Result<(), String> {
    let location = agent_path(&agents, call, &path)?;
    if location.exists() && !replace {
        return Err(format!(
            "{path} is there already: say `replace` to write over it"
        ));
    }
    std::fs::write(&location, text).map_err(|error| format!("Couldn't write {path}: {error}"))
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
