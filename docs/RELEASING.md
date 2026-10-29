# Releasing

A release is the macOS app as a universal disk image (Developer ID signed, notarized, stapled),
the Windows installers (NSIS and MSI) and the Linux packages (AppImage, deb, rpm), each with its
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
