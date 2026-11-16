import { invoke, isTauri } from "@tauri-apps/api/core";
import * as Sentry from "@sentry/nextjs";

export type CrashReportingStatus = {
	enabled: boolean;
	decided: boolean;
	configured: boolean;
	active: boolean;
};

const preferenceKey = "magnetcut-crash-reporting";
let initialized = false;
let enabled = false;

export async function getCrashReportingStatus(): Promise<CrashReportingStatus> {
	if (isTauri()) return invoke("crash_reporting_status");
	const preference = localStorage.getItem(preferenceKey);
	return {
		enabled: preference === "enabled",
		decided: preference === "enabled" || preference === "disabled",
		configured: Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN),
		active: initialized,
	};
}

/** Native consent is stored by Rust, so it is available before WebKit starts. */
export async function setCrashReporting(
	value: boolean,
): Promise<CrashReportingStatus> {
	let status: CrashReportingStatus;
	if (isTauri()) {
		status = await invoke("set_crash_reporting", { enabled: value });
	} else {
		localStorage.setItem(preferenceKey, value ? "enabled" : "disabled");
		status = await getCrashReportingStatus();
	}
	enabled = value;
	if (value) await initializeCrashReporting();
	return isTauri() ? status : getCrashReportingStatus();
}

export async function initializeCrashReporting(): Promise<void> {
	const status = await getCrashReportingStatus();
	enabled = status.enabled;
	if (initialized || !enabled || !process.env.NEXT_PUBLIC_SENTRY_DSN) return;
	// Native probes/debug builds never activate reporting. A native reporter
	// restart is also required after first opting in.
	if (isTauri() && !status.active) return;
	if (
		process.env.NODE_ENV !== "production" &&
		process.env.NEXT_PUBLIC_SENTRY_TEST !== "1"
	)
		return;
	Sentry.init({
		dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
		release: process.env.NEXT_PUBLIC_SENTRY_RELEASE,
		environment:
			process.env.NEXT_PUBLIC_SENTRY_TEST === "1" ? "test" : "production",
		dataCollection: {
			userInfo: false,
			cookies: false,
			httpHeaders: false,
			httpBodies: [],
			urlQueryParams: false,
			stackFrameVariables: false,
		},
		tracesSampleRate: 0,
		sendClientReports: false,
		beforeSendLog: () => null,
		beforeSendMetric: () => null,
		maxBreadcrumbs: 30,
		// Avoid console messages, URLs, clicks and input text from projects.
		integrations: (defaults) =>
			defaults.filter(
				(integration) =>
					!["Breadcrumbs", "BrowserSession", "BrowserTracing"].includes(
						integration.name,
					),
			),
		beforeSend(event) {
			if (!enabled) return null;
			if (!isTauri()) {
				try {
					if (localStorage.getItem(preferenceKey) !== "enabled") return null;
				} catch {
					return null;
				}
			}
			delete event.user;
			delete event.request;
			return event;
		},
	});
	initialized = true;
}
