"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { speechApi } from "../speech";

const PROVIDERS = [
	{
		value: "elevenlabs",
		name: "ElevenLabs",
		hint: "From elevenlabs.io, Profile, API keys.",
	},
	{
		value: "openai",
		name: "OpenAI",
		hint: "From platform.openai.com, API keys.",
	},
] as const;

type KeyProvider = (typeof PROVIDERS)[number]["value"];

/**
 * Settings' keys for speaking the subtitles (docs/VOICEOVER.md): typed here
 * and kept in the system's keychain by the desktop app, which sends each only
 * to its own provider. Whether one is set is all the editor gets back.
 */
export function SpeechKeysSetting() {
	const [isSet, setIsSet] = useState<Record<KeyProvider, boolean> | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let isCurrent = true;
		speechApi
			.keys()
			.then((keys) => {
				if (isCurrent) setIsSet(keys);
			})
			.catch((reason: unknown) => {
				if (isCurrent) setError(String(reason));
			});
		return () => {
			isCurrent = false;
		};
	}, []);

	return (
		<section className="flex flex-col gap-3">
			<div className="flex flex-col gap-1">
				<Label>Voices for the subtitles</Label>
				<p className="text-muted-foreground text-xs">
					{
						"Your own keys, for Voice-over's Speak the subtitles. Kept in this computer's keychain and sent only to their own service, with the cues' text, when you speak them. This computer's own voices need none."
					}
				</p>
			</div>
			{error && (
				<p className="text-destructive text-xs">{`The keychain: ${error}`}</p>
			)}
			{PROVIDERS.map((provider) => (
				<KeyRow
					key={provider.value}
					provider={provider}
					isSet={isSet?.[provider.value] ?? null}
					onChange={(set) =>
						setIsSet((current) =>
							current ? { ...current, [provider.value]: set } : current,
						)
					}
				/>
			))}
		</section>
	);
}

function KeyRow({
	provider,
	isSet,
	onChange,
}: {
	provider: (typeof PROVIDERS)[number];
	isSet: boolean | null;
	onChange: (isSet: boolean) => void;
}) {
	const [draft, setDraft] = useState("");
	const [isSaving, setIsSaving] = useState(false);
	const id = `speech-key-${provider.value}`;

	const save = async (key: string | null) => {
		setIsSaving(true);
		try {
			await speechApi.setKey({ provider: provider.value, key });
			setDraft("");
			onChange(key !== null);
		} catch (error) {
			toast.error(`Couldn't keep the ${provider.name} key`, {
				description: String(error),
			});
		} finally {
			setIsSaving(false);
		}
	};

	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex items-center justify-between gap-2">
				<Label htmlFor={id} className="text-xs">
					{provider.name}
				</Label>
				<span className="text-muted-foreground text-xs">
					{isSet === null ? "…" : isSet ? "Key set" : "No key"}
				</span>
			</div>
			<div className="flex gap-2">
				<Input
					id={id}
					type="password"
					autoComplete="off"
					spellCheck={false}
					placeholder={isSet ? "Type a new key to replace it" : "Paste the key"}
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
					className="h-8"
				/>
				<Button
					size="sm"
					variant="outline"
					disabled={isSaving || draft.trim().length === 0}
					onClick={() => void save(draft)}
				>
					Save
				</Button>
				{isSet && (
					<Button
						size="sm"
						variant="outline"
						disabled={isSaving}
						onClick={() => void save(null)}
					>
						Remove
					</Button>
				)}
			</div>
			<p className="text-muted-foreground text-xs">{provider.hint}</p>
		</div>
	);
}
