import type { NextConfig } from "next";

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

export default nextConfig;
