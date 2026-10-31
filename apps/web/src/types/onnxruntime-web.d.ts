// onnxruntime-web's types: its package.json exports have no "types"
// condition, so bundler resolution misses the file it ships, which says this.
declare module "onnxruntime-web" {
	export * from "onnxruntime-common";
}
