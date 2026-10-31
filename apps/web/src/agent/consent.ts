import { toast } from "sonner";

// What an agent may not do on its own (docs/AUTOMATION.md): download a model.
// The window asks, and the tool waits for the answer.

// How long the question waits before it's taken for a no.
const WAIT_MS = 2 * 60 * 1000;

/** Asks the user in the window: whether they allowed it. */
export function askUser({
	title,
	description,
	allow,
}: {
	title: string;
	description: string;
	allow: string;
}): Promise<boolean> {
	return new Promise((resolve) => {
		let answered = false;
		const answer = (value: boolean) => {
			if (answered) return;
			answered = true;
			clearTimeout(timer);
			toast.dismiss(id);
			resolve(value);
		};
		const id = toast(title, {
			description,
			duration: Number.POSITIVE_INFINITY,
			action: { label: allow, onClick: () => answer(true) },
			cancel: { label: "Not now", onClick: () => answer(false) },
			onDismiss: () => answer(false),
		});
		const timer = setTimeout(() => answer(false), WAIT_MS);
	});
}

/** Whether the browser's cache `name` holds anything whose address has `part`. */
export async function isCached({
	name,
	part,
}: {
	name: string;
	part: string;
}): Promise<boolean> {
	if (typeof caches === "undefined") return false;
	const cache = await caches.open(name);
	const keys = await cache.keys();
	return keys.some((request) => request.url.includes(part));
}
