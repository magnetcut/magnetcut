# Releasing

A release is the macOS app as a universal disk image (Developer ID signed, notarized, stapled),
the Windows installers (NSIS and MSI) and the Linux packages (deb, rpm), each with its
signature as an update, and `latest.json`, which tells installed copies about it, all on a GitHub
release.

## How installed copies update

The app reads `https://github.com/magnetcut/magnetcut/releases/latest/download/latest.json`
once a day, unless that's turned off in Settings, and whenever someone clicks Check Now. That's
the `latest.json` attached to the latest *published* release: drafts and pre-releases are
invisible to it, so publishing the release is what ships the update.

The feed is only a hint. An update installs only if it carries a signature made with the
project's private key, matching `plugins.updater.pubkey` in `apps/desktop/tauri.conf.json`.
Whoever controls the feed can't get anything else installed.

Each copy takes the kind of update it was installed from: `latest.json` has an entry per
installer (`windows-x86_64-msi`, `linux-x86_64-deb`, …) besides the default one per system. The
deb and rpm updates ask for the administrator password (pkexec), as installing them did.

The App Store edition (`cargo build --no-default-features`, without the `updater` feature) has no
updater at all: the App Store updates its own apps.

## Once: keys and credentials

In `apps/desktop/release.env` (copy `apps/desktop/release.env.example`):

- **Developer ID Application certificate** for your team, in the login keychain, and `TEAM_ID`.
- **Notarization**: a notarytool keychain profile, `NOTARY_PROFILE`:
  `xcrun notarytool store-credentials <name> --apple-id <you> --team-id <team> --password <app-specific password>`.
- **The updater key**, made once with `cargo tauri signer generate -w <file>`; `UPDATER_KEY` is
  that file, and its password goes in the login keychain, named by `UPDATER_KEY_PASSWORD_ITEM`.
  Its public half, `<file>.pub`, is `plugins.updater.pubkey` in `apps/desktop/tauri.conf.json`.
  **Keep the key somewhere backed up, out of the repository.** If it's lost, installed copies can
  never be updated again: they'd have to be reinstalled by hand from a build with a new public
  key. Nothing else holds it: CI builds the Windows and Linux installers without any key, and
  the script signs them on your Mac.

And the tools: `cargo install tauri-cli --version '^2' --locked`, `rustup target add
aarch64-apple-darwin x86_64-apple-darwin`, `gh` (logged in) and `jq`.

## Making a release

1. Bump `version` in `apps/desktop/Cargo.toml` (`cargo build -p magnetcut` updates
   `Cargo.lock`). It's the only place the version is: Tauri, the About box and `latest.json`
   read it from there.
2. In `CHANGELOG.md`, turn `## Unreleased` into `## [x.y.z] - YYYY-MM-DD`, add a new empty
   Unreleased above it and the `[x.y.z]:` link at the bottom. That section is the release notes,
   on GitHub and in the update dialog.
3. Commit and push.
4. `apps/desktop/scripts/release.sh`, into `target/release-files/`. It refuses a dirty working
   tree, then:
   - starts `.github/workflows/release.yml` on the pushed commit, which builds the Windows and
     Linux installers (about 15 minutes), unless a run for the commit is already there;
   - meanwhile builds the macOS app (universal), notarizes it and then the disk image (a few
     minutes each), staples both and checks the image as a download;
   - waits for the run, downloads the installers and checks they're this version;
   - signs each update, checking the signature against the public key in `tauri.conf.json`,
     and writes `latest.json`.
5. `apps/desktop/scripts/release.sh --upload` creates the draft release `vx.y.z` with the
   files, or replaces a draft's files. A published release is never replaced: a new build is a
   new version.
6. Read the draft on GitHub, then publish it. Publishing creates the tag.

## Not signed yet

The Windows installers have no Authenticode signature, so SmartScreen warns the first time one
is opened. The updates themselves are signed with the updater key either way.

## After publishing

- Installed copies see the update within a day; Check Now sees it at once.
- `https://github.com/magnetcut/magnetcut/releases/latest/download/MagnetCut.dmg` always
  downloads the latest macOS app, for links that shouldn't change.

## The Mac App Store edition

The same app without the updater (`--no-default-features`: no Check for Updates in the menu,
Settings or About), sandboxed, under its own bundle id so that its settings and projects stay
apart from the direct download's. It goes to App Store Connect as an installer package, and the
App Store updates it. The sandbox (`apps/desktop/AppStore.entitlements`) lets it open and save
the files the user picks, write to Downloads and make outgoing connections (fonts, transcription
models).

### Once

- In Certificates, Identifiers & Profiles: an App ID for the store edition, `APP_STORE_BUNDLE_ID`
  (no capabilities to add), and a **Mac App Store Connect** provisioning profile for it,
  downloaded to `APP_STORE_PROFILE`.
- The team's **Apple Distribution** and **Mac Installer Distribution** certificates, in the login
  keychain.
- In App Store Connect, Apps → New App: macOS, that bundle id. The API can't create it.
- An App Store Connect API key (Users and Access → Integrations, App Manager): the `.p8` in
  `~/.appstoreconnect/private_keys/AuthKey_<key id>.p8`, where altool looks, and `ASC_KEY_JSON`
  (or `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`) in `apps/desktop/release.env`.
- Xcode 26, whose actool turns `apps/desktop/icons/MagnetCut.icon` into the macOS 26 icon.

### Each version

1. On the release's commit, `apps/desktop/scripts/app-store.sh`, into `target/app-store/`. It
   refuses a dirty working tree, then:
   - builds the universal app with the store's bundle id, entitlements, profile and build number
     (the version, unless `BUILD_NUMBER` says otherwise), signed as Apple Distribution;
   - checks the bundle id, the build number, the profile, the icon, both architectures, that the
     updater isn't in it, the signature, the sandbox, that nothing is quarantined and that every
     file stays readable once installed;
   - packages it with productbuild, signed as Mac Installer Distribution, and has App Store
     Connect validate it.
2. `apps/desktop/scripts/app-store.sh --upload` validates it again and uploads it as a new build.
   App Store Connect takes each build number once: another build of the same version is
   `BUILD_NUMBER=x.y.z.1 apps/desktop/scripts/app-store.sh --upload`.
3. In App Store Connect: the listing, the screenshots and the privacy answers (Data Not
   Collected), then submit the build for review. Submitting is what ships it, as publishing
   does on GitHub.
