// bun test can't load a wasm-bindgen "bundler" package: it hands the .wasm
// import over without instantiating it. This does what the bundler would:
// instantiate it with its JS glue as the import object.
import { plugin } from "bun";
import { basename } from "node:path";

plugin({
	name: "wasm-bindgen-bundler",
	setup(build) {
		build.onLoad({ filter: /_bg\.wasm$/ }, async ({ path }) => {
			const glue = `./${basename(path, ".wasm")}.js`;
			const imports = {
				[glue]: await import(path.replace(/\.wasm$/, ".js")),
			};
			const wasmModule = new WebAssembly.Module(
				await Bun.file(path).arrayBuffer(),
			);
			const { exports } = new WebAssembly.Instance(wasmModule, imports);
			return { exports, loader: "object" };
		});
	},
});
