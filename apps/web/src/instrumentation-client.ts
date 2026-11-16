import { initializeCrashReporting } from "./desktop/crash-reporting";

// Storage can be unavailable. Reporting must never prevent the editor loading.
void initializeCrashReporting().catch(() => {});
