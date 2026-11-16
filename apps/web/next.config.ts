import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs/config";

// Static export: there is no server runtime to instrument.
process.env.SENTRY_SUPPRESS_INSTRUMENTATION_FILE_WARNING = "1";

const nextConfig: NextConfig = {
	compiler: {
		removeConsole: process.env.NODE_ENV === "production",
	},
	reactStrictMode: true,
	productionBrowserSourceMaps: true,
	// The desktop app serves the built files itself: there's no server.
	output: "export",
	images: {
		unoptimized: true,
	},
};

export default withSentryConfig(nextConfig, {
	telemetry: false,
	suppressOnRouterTransitionStartWarning: true, // Error reporting only.
	org: process.env.SENTRY_ORG,
	project: process.env.SENTRY_PROJECT_WEB,
	authToken: process.env.SENTRY_AUTH_TOKEN,
	release: {
		name: process.env.SENTRY_RELEASE,
		create: Boolean(process.env.SENTRY_AUTH_TOKEN),
	},
	sourcemaps: {
		disable: !process.env.SENTRY_AUTH_TOKEN,
		deleteSourcemapsAfterUpload: false,
	},
});
