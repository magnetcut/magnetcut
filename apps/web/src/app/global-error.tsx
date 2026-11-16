"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";
import { initializeCrashReporting } from "@/desktop/crash-reporting";

export default function GlobalError({
	error,
	reset,
}: {
	error: Error & { digest?: string };
	reset: () => void;
}) {
	useEffect(() => {
		void initializeCrashReporting()
			.then(() => Sentry.captureException(error))
			.catch(() => {});
	}, [error]);
	return (
		<html lang="en">
			<body>
				<h1>MagnetCut couldn’t display this page</h1>
				<button onClick={reset}>Try again</button>
			</body>
		</html>
	);
}
