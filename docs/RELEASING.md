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

The release workflow (`.github/workflows/release.yml`) signs with the secrets of the repository's
`release` environment (Settings → Environments). Only main may deploy to it (its deployment
branches), so neither a pull request's workflows nor this one changed on a branch can read them:

- `MACOS_CERT_P12_BASE64` and `MACOS_CERT_PASSWORD`: the team's **Developer ID Application**
  certificate with its private key, exported from Keychain Access as .p12, in base64, and that
  export's password; and the environment's variable `APPLE_TEAM_ID`.
- `APPLE_API_KEY_B64`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`: an **App Store Connect API
  key** (Users and Access → Integrations), which notarytool notarizes with: the `.p8` in base64,
  its key id and the issuer id.
- `UPDATER_KEY` and `UPDATER_KEY_PASSWORD`: **the updater key**, made once with `cargo tauri
  signer generate -w <file>`, as the file's text, and its password. Its public half,
  `<file>.pub`, is `plugins.updater.pubkey` in `apps/desktop/tauri.conf.json`. **Keep the file
  somewhere backed up, out of the repository**: GitHub never gives a secret back. If it's lost,
  installed copies can never be updated again: they'd have to be reinstalled by hand from a
  build with a new public key.
- `SENTRY_AUTH_TOKEN`, a repository secret, optional: the symbols and source maps for crash
  reports.

Whoever can push to main can still sign with them: required reviewers on the environment make
each release wait for an approval.

To release from a Mac instead, `apps/desktop/release.env` (copy
`apps/desktop/release.env.example`): `TEAM_ID`, with the Developer ID certificate in the login
keychain; `NOTARY_PROFILE`, a notarytool keychain profile (`xcrun notarytool store-credentials
<name> --apple-id <you> --team-id <team> --password <app-specific password>`), or the API key
as `APPLE_API_KEY_PATH`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`; `UPDATER_KEY`, the key's
file, with its password in the login keychain, named by `UPDATER_KEY_PASSWORD_ITEM`. And the
tools: `cargo install tauri-cli --version '^2' --locked`, `rustup target add
aarch64-apple-darwin x86_64-apple-darwin`, `gh` (logged in) and `jq`.

## Making a release

1. Bump `version` in `apps/desktop/Cargo.toml` (`cargo build -p magnetcut` updates
   `Cargo.lock`). It's the only place the version is: Tauri, the About box and `latest.json`
   read it from there.
2. In `CHANGELOG.md`, turn `## Unreleased` into `## [x.y.z] - YYYY-MM-DD`, add a new empty
   Unreleased above it and the `[x.y.z]:` link at the bottom. That section is the release notes,
   on GitHub and in the update dialog.
3. Commit and push.
4. `gh workflow run release.yml --repo magnetcut/magnetcut --ref main`. The run (about 30
   minutes):
   - builds the Windows and Linux installers and, meanwhile, the macOS app
     (`apps/desktop/scripts/release.sh --mac`): universal, signed, notarized, then the disk
     image, both stapled, and the image checked as a download;
   - then signs each update (`release.sh --sign`), checking the signature against the public
     key in `tauri.conf.json`, writes `latest.json`, and creates the draft release `vx.y.z` with
     the files (`release.sh --upload`), or replaces a draft's files. A published release is
     never replaced: a new build is a new version.
5. Read the draft on GitHub, then publish it. Publishing creates the tag.

### From a Mac

`apps/desktop/scripts/release.sh` does step 4 on a Mac with the keys, into
`target/release-files/`. It refuses a dirty working tree, then starts the workflow on the pushed
commit with `mac=false`, for the installers alone, unless a run for the commit is already
there; builds and notarizes the macOS app meanwhile; waits for the run and downloads the
installers; signs each update and writes `latest.json`. Then `release.sh --upload` makes the
draft.

When the updater's key is on another Mac: `release.sh --unsigned` does that but for the
signatures and `latest.json`. Copy `target/release-files/` to the Mac with the key, at the same
commit, run `release.sh --sign` there (in its Terminal: over SSH the login keychain is locked),
copy the folder back and go on with `--upload`.

## Not signed yet

The Windows installers have no Authenticode signature, so SmartScreen warns the first time one
is opened. The updates themselves are signed with the updater key either way.

## After publishing

- Installed copies see the update within a day; Check Now sees it at once.
- `https://github.com/magnetcut/magnetcut/releases/latest/download/MagnetCut.dmg` always
  downloads the latest macOS app, and `.../MagnetCut_x64-setup.exe` the latest Windows
  installer, for links that shouldn't change. Updates don't use these: `latest.json` names
  each version's own files.

## The Mac App Store edition

The same app without the updater (`--no-default-features`: no Check for Updates in the menu,
Settings or About), sandboxed, under its own bundle id so that its settings and projects stay
apart from the direct download's. It goes to App Store Connect as an installer package, and the
App Store updates it. The sandbox (`apps/desktop/AppStore.entitlements`) lets it open and save
the files the user picks, keep bookmarks to the media it reads where it is (to open it again
after a relaunch), read and write Downloads and Movies, make outgoing connections (fonts,
transcription models), and listen on 127.0.0.1 for agent mode (docs/AUTOMATION.md). App Review
asks why it listens: in the review notes, "Settings, Let agents use MagnetCut, off by default:
AI agents the user adds there (Claude Code, Codex) edit and export through MCP on 127.0.0.1
only, each with a token shown in Settings."

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
     (x.y.z×100 for version x.y.z: 0.1.0 is 0.1.0, 0.1.1 is 0.1.100), signed as Apple
     Distribution;
   - checks the bundle id, the build number, the profile, the icon, both architectures, that the
     updater isn't in it, the signature, the sandbox, that nothing is quarantined and that every
     file stays readable once installed;
   - packages it with productbuild, signed as Mac Installer Distribution, and has App Store
     Connect validate it.
2. `apps/desktop/scripts/app-store.sh --upload` validates it again and uploads it as a new build.
   App Store Connect takes each build number once, and a Mac build number is at most three
   numbers, each higher than the last: another build of the same version is
   `STORE_BUILD=1 apps/desktop/scripts/app-store.sh --upload` (0.1.0's is 0.1.1), then 2.
3. In App Store Connect: the listing, the screenshots and the privacy answers (Data Not
   Collected), then submit the build for review. Submitting is what ships it, as publishing
   does on GitHub.
