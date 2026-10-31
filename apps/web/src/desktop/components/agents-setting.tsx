import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

// Settings, Agents (docs/AUTOMATION.md): agent mode on or off, and the agents
// let in, each with its own token, shown once when it's added, in the lines
// to paste into Claude Code or Codex.

interface AgentView {
	id: string;
	name: string;
	created: number;
	lastUsed: number | null;
}

interface AgentSettings {
	enabled: boolean;
	port: number | null;
	running: boolean;
	url: string | null;
	sandboxed: boolean;
	agents: AgentView[];
}

interface Added {
	id: string;
	token: string;
	settings: AgentSettings;
}

function pasteLines({ url, token }: { url: string; token: string }) {
	return [
		{
			label: "Claude Code",
			line: `claude mcp add --transport http magnetcut ${url} --header "Authorization: Bearer ${token}"`,
		},
		{
			label: "Codex",
			line: `export MAGNETCUT_TOKEN=${token}\ncodex mcp add magnetcut --url ${url} --bearer-token-env-var MAGNETCUT_TOKEN`,
		},
	];
}

export function AgentsSetting() {
	const [settings, setSettings] = useState<AgentSettings | null>(null);
	const [name, setName] = useState("");
	const [added, setAdded] = useState<{ name: string; token: string } | null>(
		null,
	);

	useEffect(() => {
		void invoke<AgentSettings>("agent_settings").then(setSettings);
	}, []);

	if (!settings) return null;

	const fail = (error: unknown) => toast.error(String(error));

	return (
		<section className="flex flex-col gap-3">
			<div className="flex items-start justify-between gap-4">
				<div className="flex flex-col gap-1">
					<Label htmlFor="agents-enabled">Let agents use MagnetCut</Label>
					<p className="text-muted-foreground text-xs">
						Claude Code, Codex or another agent edits and exports in this
						window, on this computer only, each with its own token.
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
				<>
					<p className="text-muted-foreground text-xs">
						{settings.running && settings.url
							? `Serving on ${settings.url}`
							: "Not serving: switch it off and on again"}
					</p>
					{settings.agents.map((agent) => (
						<div
							key={agent.id}
							className="flex items-center justify-between gap-4 text-sm"
						>
							<div className="flex flex-col">
								<span>{agent.name}</span>
								<span className="text-muted-foreground text-xs">
									{agent.lastUsed
										? `Last used ${new Date(
												agent.lastUsed * 1000,
											).toLocaleString(undefined, {
												dateStyle: "medium",
												timeStyle: "short",
											})}`
										: "Not used yet"}
								</span>
							</div>
							<Button
								size="sm"
								variant="outline"
								onClick={() => {
									invoke<AgentSettings>("agent_revoke", { id: agent.id })
										.then(setSettings)
										.catch(fail);
								}}
							>
								Revoke
							</Button>
						</div>
					))}
					{added && settings.url ? (
						<div className="flex flex-col gap-2 rounded-md border p-3 text-xs">
							<p>
								{added.name}&apos;s token, shown this once. Paste the line for
								your agent:
							</p>
							{pasteLines({ url: settings.url, token: added.token }).map(
								({ label, line }) => (
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
								),
							)}
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
										setSettings(result.settings);
										setAdded({ name: agentName, token: result.token });
										setName("");
									})
									.catch(fail);
							}}
						>
							<Input
								value={name}
								placeholder="Claude Code on this Mac"
								onChange={(event) => setName(event.target.value)}
							/>
							<Button type="submit" size="sm" variant="outline">
								Add an agent
							</Button>
						</form>
					)}
				</>
			)}
		</section>
	);
}
