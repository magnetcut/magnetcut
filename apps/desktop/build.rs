fn main() {
    // capabilities/updates.json grants the updater's permissions, which exist
    // only with its plugin: the App Store edition (no `updater` feature)
    // leaves the file out.
    let capabilities = if std::env::var_os("CARGO_FEATURE_UPDATER").is_some() {
        "./capabilities/*.json"
    } else {
        "./capabilities/default.json"
    };
    let attributes = tauri_build::Attributes::new().capabilities_path_pattern(capabilities);
    if let Err(error) = tauri_build::try_build(attributes) {
        println!("{error:#}");
        std::process::exit(1);
    }
}
