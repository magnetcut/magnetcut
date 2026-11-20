import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

// Settings, Agents (docs/AUTOMATION.md): agent mode on or off; Connect, which
// adds MagnetCut to Claude Code (its plugin), Codex or OpenCode with a token
// of its own (src/agent/clients.rs); and any other agent, added by hand, its
// token shown once in the lines to paste.

type Client = "claude-code" | "codex" | "opencode";

interface AgentView {
	id: string;
	name: string;
	created: number;
	lastUsed: number | null;
	client: Client | null;
}

interface AgentSettings {
	enabled: boolean;
	port: number | null;
	running: boolean;
	url: string | null;
	sandboxed: boolean;
	program: string | null;
	folders: string[];
	agents: AgentView[];
}

interface ClientView {
	client: Client;
	name: string;
	installed: boolean;
}

interface Added {
	id: string;
	token: string;
	settings: AgentSettings;
}

/** What Connect does for each, in a few words. */
const CLIENT_NOTES: Record<Client, string> = {
	"claude-code":
		"Installs the MagnetCut plugin, with a skill on editing with it",
	codex: "Adds MagnetCut, which Codex opens when it needs it",
	opencode: "Adds MagnetCut's server to OpenCode",
};

const EXAMPLES = [
	"Open my latest MagnetCut project and take out the silences.",
	"Put the clips in ~/Movies/Trip on the timeline with dissolves between them.",
	"Export this project for YouTube to ~/Movies/trip.mp4.",
];

function pasteLines({
	url,
	token,
	program,
}: {
	url: string;
	token: string;
	program: string | null;
}) {
	const others = program
		? [
				{
					label: "Any other agent (MCP on standard input and output)",
					line: JSON.stringify(
						{
							command: program,
							args: ["--mcp"],
							env: { MAGNETCUT_URL: url, MAGNETCUT_TOKEN: token },
						},
						null,
						2,
					),
				},
			]
		: [];
	return [
		{
			label: "Claude Code",
			line: `claude mcp add --transport http magnetcut ${url} --header "Authorization: Bearer ${token}"`,
		},
		{
			label: "Codex",
			line: `export MAGNETCUT_TOKEN=${token}\ncodex mcp add magnetcut --url ${url} --bearer-token-env-var MAGNETCUT_TOKEN`,
		},
		{
			label: "OpenCode",
			line: `opencode mcp add magnetcut --url ${url} --header "Authorization=Bearer ${token}"`,
		},
		...others,
	];
}

function lastUsed({ agent }: { agent: AgentView }) {
	return agent.lastUsed
		? `Last used ${new Date(agent.lastUsed * 1000).toLocaleString(undefined, {
				dateStyle: "medium",
				timeStyle: "short",
			})}`
		: "Not used yet";
}

export function AgentsSetting() {
	const [settings, setSettings] = useState<AgentSettings | null>(null);

	useEffect(() => {
		void invoke<AgentSettings>("agent_settings").then(setSettings);
	}, []);

	if (!settings) return null;

	const fail = (error: unknown) => toast.error(String(error));

	return (
		<>
			<section className="flex flex-col gap-3">
				<div className="flex items-start justify-between gap-4">
					<div className="flex flex-col gap-1">
						<Label htmlFor="agents-enabled">Let agents use MagnetCut</Label>
						<p className="text-muted-foreground text-xs">
							An agent such as Claude Code, Codex or OpenCode reads the
							timeline, cuts, trims, adds titles and transitions, looks at
							frames, listens and exports, here in this window, where you see
							every change and can stop it. On this computer only: each agent
							has a token of its own, and nothing is served while this is off.
							{settings.sandboxed
								? " In this edition, files only as the App Store's sandbox allows."
								: ""}
						</p>
					</div>
					<Switch
						id="agents-enabled"
						checked={settings.enabled}
						onCheckedChange={(enabled) => {
							invoke<AgentSettings>("agent_set_enabled", { enabled })
								.then(setSettings)
								.catch(fail);
						}}
					/>
				</div>
				{settings.enabled && (
					<p className="text-muted-foreground text-xs">
						{settings.running && settings.url
							? `Serving on ${settings.url}`
							: "Not serving: switch it off and on again"}
					</p>
				)}
				{!settings.enabled && (
					<ol className="text-muted-foreground list-decimal space-y-1 pl-4 text-xs">
						<li>Switch this on.</li>
						<li>
							{settings.sandboxed
								? "Add your agent under Other agents, and paste the line it shows into it."
								: "Connect Claude Code, Codex or OpenCode: one click each."}
						</li>
						<li>Ask your agent to edit a video in MagnetCut.</li>
					</ol>
				)}
			</section>
			{settings.enabled && !settings.sandboxed && (
				<ConnectSection
					settings={settings}
					onSettings={setSettings}
					onError={fail}
				/>
			)}
			{settings.enabled && (
				<section className="flex flex-col gap-2">
					<Label>Then ask your agent, for example</Label>
					<ul className="text-muted-foreground space-y-1 text-xs">
						{EXAMPLES.map((example) => (
							<li key={example}>“{example}”</li>
						))}
					</ul>
				</section>
			)}
			{settings.enabled && settings.sandboxed && (
				<FoldersSection
					settings={settings}
					onSettings={setSettings}
					onError={fail}
				/>
			)}
			{settings.enabled && (
				<OtherAgentsSection
					settings={settings}
					onSettings={setSettings}
					onError={fail}
				/>
			)}
		</>
	);
}

interface SectionProps {
	settings: AgentSettings;
	onSettings: (settings: AgentSettings) => void;
	onError: (error: unknown) => void;
}

/** Claude Code, Codex and OpenCode: MagnetCut added to each in one click. */
function ConnectSection({ settings, onSettings, onError }: SectionProps) {
	const [clients, setClients] = useState<ClientView[] | null>(null);
	const [busy, setBusy] = useState<Client | null>(null);

	useEffect(() => {
		void invoke<ClientView[]>("agent_clients").then(setClients);
	}, []);

	const act = async ({
		client,
		name,
		connect,
	}: {
		client: Client;
		name: string;
		connect: boolean;
	}) => {
		setBusy(client);
		try {
			onSettings(
				await invoke<AgentSettings>(
					connect ? "agent_connect" : "agent_disconnect",
					{ client },
				),
			);
			if (connect) {
				toast.success(`MagnetCut is in ${name}`, {
					description: `Start a new ${name} session to use it.`,
				});
			}
		} catch (error) {
			onError(error);
			// What's left: a token taken back whatever happened.
			onSettings(await invoke<AgentSettings>("agent_settings"));
		} finally {
			setBusy(null);
		}
	};

	return (
		<section className="flex flex-col gap-3">
			<div className="flex flex-col gap-1">
				<Label>Connect an agent</Label>
				<p className="text-muted-foreground text-xs">
					MagnetCut adds itself to the agent, with a token of its own.
					Disconnect takes it out, and the token stops working at once.
				</p>
			</div>
			{clients === null ? (
				<p className="text-muted-foreground text-xs">Looking for agents…</p>
			) : (
				<div className="divide-y rounded-md border">
					{clients.map(({ client, name, installed }) => {
						const agent = settings.agents.find(
							(candidate) => candidate.client === client,
						);
						return (
							<div
								key={client}
								className="flex items-center justify-between gap-4 px-3 py-2.5"
							>
								<div className="flex min-w-0 flex-col">
									<span className="text-sm">{name}</span>
									<span className="text-muted-foreground text-xs">
										{agent
											? `Connected · ${lastUsed({ agent })}`
											: installed
												? CLIENT_NOTES[client]
												: "Not installed on this computer"}
									</span>
								</div>
								{agent ? (
									<Button
										size="sm"
										variant="outline"
										disabled={busy !== null}
										onClick={() => void act({ client, name, connect: false })}
									>
										{busy === client ? "Disconnecting…" : "Disconnect"}
									</Button>
								) : (
									<Button
										size="sm"
										variant="outline"
										disabled={!installed || busy !== null || !settings.running}
										onClick={() => void act({ client, name, connect: true })}
									>
										{busy === client ? "Connecting…" : "Connect"}
									</Button>
								)}
							</div>
						);
					})}
				</div>
			)}
		</section>
	);
}

/** In the App Store edition, the folders agents may use besides Movies and Downloads. */
function FoldersSection({ settings, onSettings, onError }: SectionProps) {
	return (
		<section className="flex flex-col gap-2">
			<div className="flex items-center justify-between gap-4">
				<div className="flex flex-col gap-1">
					<Label>Folders agents may use</Label>
					<span className="text-muted-foreground text-xs">
						Besides Movies and Downloads. For a file elsewhere, the window asks
						you.
					</span>
				</div>
				<Button
					size="sm"
					variant="outline"
					onClick={() => {
						invoke<AgentSettings>("agent_add_folder")
							.then(onSettings)
							.catch(onError);
					}}
				>
					Add a folder
				</Button>
			</div>
			{settings.folders.map((folder) => (
				<div
					key={folder}
					className="flex items-center justify-between gap-4 text-xs"
				>
					<span className="truncate">{folder}</span>
					<Button
						size="sm"
						variant="ghost"
						className="h-6"
						onClick={() => {
							invoke<AgentSettings>("agent_remove_folder", { path: folder })
								.then(onSettings)
								.catch(onError);
						}}
					>
						Remove
					</Button>
				</div>
			))}
		</section>
	);
}

/** Any other agent, added by hand: its token shown once, in the lines to paste. */
function OtherAgentsSection({ settings, onSettings, onError }: SectionProps) {
	const [name, setName] = useState("");
	const [added, setAdded] = useState<{ name: string; token: string } | null>(
		null,
	);
	const others = settings.agents.filter((agent) => agent.client === null);

	return (
		<section className="flex flex-col gap-3">
			<div className="flex flex-col gap-1">
				<Label>Other agents</Label>
				<p className="text-muted-foreground text-xs">
					Any agent that speaks MCP: add it, and paste the line MagnetCut shows
					into it.
				</p>
			</div>
			{others.map((agent) => (
				<div
					key={agent.id}
					className="flex items-center justify-between gap-4 text-sm"
				>
					<div className="flex flex-col">
						<span>{agent.name}</span>
						<span className="text-muted-foreground text-xs">
							{lastUsed({ agent })}
						</span>
					</div>
					<Button
						size="sm"
						variant="outline"
						onClick={() => {
							invoke<AgentSettings>("agent_revoke", { id: agent.id })
								.then(onSettings)
								.catch(onError);
						}}
					>
						Revoke
					</Button>
				</div>
			))}
			{added && settings.url ? (
				<div className="flex flex-col gap-2 rounded-md border p-3 text-xs">
					<p>
						{added.name}&apos;s token, shown this once. Paste the line for your
						agent:
					</p>
					{pasteLines({
						url: settings.url,
						token: added.token,
						program: settings.program,
					}).map(({ label, line }) => (
						<div key={label} className="flex flex-col gap-1">
							<div className="flex items-center justify-between">
								<span className="font-medium">{label}</span>
								<Button
									size="sm"
									variant="ghost"
									className="h-6"
									onClick={() => {
										void navigator.clipboard
											.writeText(line)
											.then(() => toast.success("Copied"));
									}}
								>
									Copy
								</Button>
							</div>
							<code className="bg-muted rounded p-2 break-all whitespace-pre-wrap">
								{line}
							</code>
						</div>
					))}
					<Button size="sm" onClick={() => setAdded(null)}>
						Done
					</Button>
				</div>
			) : (
				<form
					className="flex gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						const agentName = name.trim() || "Agent";
						invoke<Added>("agent_add", { name: agentName })
							.then((result) => {
								onSettings(result.settings);
								setAdded({ name: agentName, token: result.token });
								setName("");
							})
							.catch(onError);
					}}
				>
					<Input
						value={name}
						placeholder="My agent"
						onChange={(event) => setName(event.target.value)}
					/>
					<Button type="submit" size="sm" variant="outline">
						Add an agent
					</Button>
				</form>
			)}
		</section>
	);
}
