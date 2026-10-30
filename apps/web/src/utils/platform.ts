export function getPlatformSpecialKey(): string {
	return isAppleDevice() ? "⌘" : "Ctrl";
}

export function getPlatformAlternateKey(): string {
	return isAppleDevice() ? "⌥" : "Alt";
}

export function isAppleDevice(): boolean {
	return /(Mac|iPhone|iPod|iPad)/i.test(navigator.platform);
}

export function isLinux(): boolean {
	return (
		/Linux/i.test(navigator.platform) && !/Android/i.test(navigator.userAgent)
	);
}
