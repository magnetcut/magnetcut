// What this system's web view can do, of what the editor needs. Run by the
// app with MAGNETCUT_PROBE=1 on each page load; the report goes back to Rust.
(async () => {
	const report = { userAgent: navigator.userAgent, origin: location.origin };
	const attempt = async (check) => {
		try {
			return await check();
		} catch (error) {
			return `error: ${error?.message || error?.name || error}`;
		}
	};

	report.secureContext = isSecureContext;
	report.crossOriginIsolated = crossOriginIsolated;
	report.sharedArrayBuffer = typeof SharedArrayBuffer !== "undefined";
	report.offscreenCanvas = typeof OffscreenCanvas !== "undefined";
	report.audioContext = typeof AudioContext !== "undefined";

	report.webgpu = await attempt(async () => {
		if (!navigator.gpu) return false;
		const adapter = await navigator.gpu.requestAdapter();
		if (!adapter) return "no adapter";
		const info = adapter.info ?? {};
		return `${info.vendor || "?"} ${info.architecture || ""}`.trim();
	});
	report.webgl2 = await attempt(
		() => !!document.createElement("canvas").getContext("webgl2"),
	);

	const videoCodecs = {
		h264: "avc1.640028",
		hevc: "hvc1.1.6.L120.B0",
		vp9: "vp09.00.40.08",
		av1: "av01.0.08M.08",
	};
	const audioCodecs = { aac: "mp4a.40.2", opus: "opus" };
	report.videoEncode = {};
	report.videoDecode = {};
	for (const [name, codec] of Object.entries(videoCodecs)) {
		report.videoEncode[name] = await attempt(async () =>
			typeof VideoEncoder === "undefined"
				? "no VideoEncoder"
				: (
						await VideoEncoder.isConfigSupported({
							codec,
							width: 1920,
							height: 1080,
							bitrate: 8_000_000,
							framerate: 30,
						})
					).supported,
		);
		report.videoDecode[name] = await attempt(async () =>
			typeof VideoDecoder === "undefined"
				? "no VideoDecoder"
				: (
						await VideoDecoder.isConfigSupported({
							codec,
							codedWidth: 1920,
							codedHeight: 1080,
						})
					).supported,
		);
	}
	report.audioEncode = {};
	report.audioDecode = {};
	for (const [name, codec] of Object.entries(audioCodecs)) {
		const config = { codec, sampleRate: 48000, numberOfChannels: 2 };
		report.audioEncode[name] = await attempt(async () =>
			typeof AudioEncoder === "undefined"
				? "no AudioEncoder"
				: (
						await AudioEncoder.isConfigSupported({
							...config,
							bitrate: 128_000,
						})
					).supported,
		);
		report.audioDecode[name] = await attempt(async () =>
			typeof AudioDecoder === "undefined"
				? "no AudioDecoder"
				: (await AudioDecoder.isConfigSupported(config)).supported,
		);
	}

	report.indexedDB = typeof indexedDB !== "undefined";
	report.storageAPI = typeof navigator.storage !== "undefined";
	// Written as the editor writes imported media (services/storage).
	// Each step named, so that a failure says where.
	report.opfs = await attempt(async () => {
		let step = "getDirectory";
		try {
			const root = await navigator.storage.getDirectory();
			step = "getFileHandle";
			const file = await root.getFileHandle("magnetcut-probe", { create: true });
			step = "createWritable";
			const writable = await file.createWritable();
			step = "write";
			await writable.write("probe");
			await writable.close();
			step = "read";
			const text = await (await file.getFile()).text();
			step = "removeEntry";
			await root.removeEntry("magnetcut-probe");
			return text === "probe";
		} catch (error) {
			throw new Error(`${step}: ${error?.name}: ${error?.message}`);
		}
	});
	// Without createWritable, the app writes through a sync access handle in a
	// worker (apps/web/src/services/storage/opfs-write-worker.ts).
	report.opfsSyncAccess = await attempt(
		() =>
			new Promise((resolve, reject) => {
				const code = `onmessage = async () => {
					try {
						const root = await navigator.storage.getDirectory();
						const file = await root.getFileHandle("magnetcut-probe-sync", { create: true });
						const access = await file.createSyncAccessHandle();
						await access.truncate(0);
						await access.write(new TextEncoder().encode("probe"), { at: 0 });
						await access.flush();
						await access.close();
						const text = await (await file.getFile()).text();
						await root.removeEntry("magnetcut-probe-sync");
						postMessage(text === "probe");
					} catch (error) {
						postMessage("error: " + error?.message);
					}
				};`;
				const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
				const worker = new Worker(url);
				const done = (finish) => {
					worker.terminate();
					URL.revokeObjectURL(url);
					finish();
				};
				worker.onmessage = (event) => done(() => resolve(event.data));
				worker.onerror = (event) =>
					done(() => reject(new Error(event.message || "worker failed")));
				setTimeout(() => done(() => reject(new Error("timed out"))), 10000);
				worker.postMessage(null);
			}),
	);
	report.storagePersisted = await attempt(() => navigator.storage.persisted());
	report.storageQuotaGB = await attempt(async () => {
		const { quota } = await navigator.storage.estimate();
		return quota ? Math.round(quota / 1e9) : null;
	});
	report.moduleWorker = await attempt(
		() =>
			new Promise((resolve) => {
				const url = URL.createObjectURL(
					new Blob(["postMessage(1)"], { type: "text/javascript" }),
				);
				const worker = new Worker(url, { type: "module" });
				worker.onmessage = () => resolve(true);
				worker.onerror = () => resolve(false);
				setTimeout(() => resolve("timeout"), 3000);
			}),
	);

	// The app's own command: its version, and whether it updates itself.
	report.appInfo = await attempt(() =>
		window.__TAURI_INTERNALS__.invoke("app_info"),
	);
	// What the app's own export makes here (src/render/): formats and codecs.
	report.nativeExport = await attempt(() =>
		window.__TAURI_INTERNALS__.invoke("native_export_capabilities"),
	);

	window.__TAURI_INTERNALS__.invoke("probe_report", {
		report: JSON.stringify(report),
	});
})();
