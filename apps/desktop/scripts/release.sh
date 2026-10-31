#!/bin/bash
#
# Packages a release, for GitHub:
#
#   apps/desktop/scripts/release.sh           into target/release-files/:
#       MagnetCut_<version>_universal.dmg      the macOS app, universal, Developer ID
#                                              signed, notarized and stapled, in a disk
#                                              image notarized and stapled too
#       MagnetCut.dmg                          the same, a stable name for
#                                              .../releases/latest/download/
#       MagnetCut_<version>_universal.app.tar.gz   the macOS update
#       MagnetCut_<version>_x64-setup.exe, ..._x64_en-US.msi        Windows
#       MagnetCut_<version>_amd64.deb, MagnetCut-<version>-1.x86_64.rpm   Linux
#                                              built by .github/workflows/release.yml
#                                              from the same commit (this starts the
#                                              run when there isn't one)
#       *.sig                                  each update's signature
#       latest.json                            what installed copies read
#       notes.md                               this version's CHANGELOG section
#   apps/desktop/scripts/release.sh --unsigned   the same but for the signatures and
#                                              latest.json, on a Mac without the
#                                              updater's key; then, at the same commit,
#   apps/desktop/scripts/release.sh --sign       on the Mac with the key, with
#                                              target/release-files copied there: signs
#                                              the updates and writes latest.json
#   apps/desktop/scripts/release.sh --upload  put those on a *draft* GitHub release
#                                              v<version>, for a person to read and
#                                              publish. Publishing it is what makes
#                                              installed copies see the update: their
#                                              feed is the latest release's latest.json.
#
# Needs (apps/desktop/release.env, or the environment; see release.env.example):
#   - TEAM_ID, with its Developer ID Application certificate in the keychain;
#   - notarization: NOTARY_PROFILE (a notarytool keychain profile), or
#     APPLE_API_KEY_PATH, APPLE_API_KEY_ID and APPLE_API_ISSUER;
#   - UPDATER_KEY, the updater's private key, and its password: in the login
#     keychain (UPDATER_KEY_PASSWORD_ITEM) or in TAURI_SIGNING_PRIVATE_KEY_PASSWORD
#     (not for --unsigned; only these, cargo tauri and jq for --sign);
#   - cargo tauri (tauri-cli 2), gh, jq, and the Rust targets
#     aarch64-apple-darwin and x86_64-apple-darwin.
#
# Each step checks its own result: an exit status of 0 is not evidence that
# a signature or a ticket is there.
#
set -euo pipefail
DESKTOP="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$DESKTOP/../.." && pwd)"
cd "$ROOT"

APP_NAME=MagnetCut
REPO=magnetcut/magnetcut
WORKFLOW=release.yml
OUT=target/release-files
BUNDLE=target/universal-apple-darwin/release/bundle/macos
APP="$BUNDLE/$APP_NAME.app"

say() { printf "\n\033[1;34m==>\033[0m %s\n" "$*"; }
die() { printf "\n\033[1;31mERROR:\033[0m %s\n" "$*" >&2; exit 1; }

[ -f "$DESKTOP/release.env" ] && source "$DESKTOP/release.env"

VERSION=$(sed -n 's/^version = "\(.*\)"/\1/p' apps/desktop/Cargo.toml | head -1)
TAG="v$VERSION"
DMG="$OUT/${APP_NAME}_${VERSION}_universal.dmg"
MAC_UPDATE="$OUT/${APP_NAME}_${VERSION}_universal.app.tar.gz"
# The names Tauri gives what CI builds.
WINDOWS_NSIS="${APP_NAME}_${VERSION}_x64-setup.exe"
WINDOWS_MSI="${APP_NAME}_${VERSION}_x64_en-US.msi"
LINUX_DEB="${APP_NAME}_${VERSION}_amd64.deb"
LINUX_RPM="${APP_NAME}-${VERSION}-1.x86_64.rpm"
INSTALLERS=("$WINDOWS_NSIS" "$WINDOWS_MSI" "$LINUX_DEB" "$LINUX_RPM")

# This version's section of the CHANGELOG ("## [0.1.0] - 2026-11-02").
# This version's section of CHANGELOG.md: up to the next version, or the
# links at the bottom, without the blank lines around it.
release_notes() {
    awk -v want="## [$VERSION]" '
        index($0, want) == 1 { inside = 1; next }
        inside && (/^## / || /^\[[^]]*\]: /) { exit }
        inside { print }
    ' CHANGELOG.md | sed -e '/./,$!d' | sed -e ':a' -e '/^\n*$/{$d;N;ba' -e '}'
}

# LaunchServices registers every app bundle it sees, including copies in a
# staging folder or a mounted image; a record left pointing at a deleted path
# can confuse it about the installed copy. Drop it while the path still exists.
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
ls_unregister() {
    [ -x "$LSREGISTER" ] || return 0
    "$LSREGISTER" -u "$1" 2>/dev/null || true
    local phys
    phys="$(cd "$(dirname "$1")" 2>/dev/null && pwd -P)/$(basename "$1")"
    if [ -n "$phys" ] && [ "$phys" != "$1" ]; then
        "$LSREGISTER" -u "$phys" 2>/dev/null || true
    fi
    return 0
}

have_api_key() {
    [ -n "${APPLE_API_KEY_PATH:-}" ] && [ -n "${APPLE_API_KEY_ID:-}" ] && [ -n "${APPLE_API_ISSUER:-}" ]
}

notarize() {
    if have_api_key; then
        xcrun notarytool submit "$1" --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY_ID" \
            --issuer "$APPLE_API_ISSUER" --wait --timeout 30m
    else
        xcrun notarytool submit "$1" --keychain-profile "$NOTARY_PROFILE" --wait --timeout 30m
    fi
}

# stapler gets the ticket from Apple (CloudKit): a dropped connection
# ("The network connection was lost", error 68) is tried again; a ticket
# that isn't there fails each time, and then for good.
stapler() {
    local i
    for i in 1 2 3; do
        xcrun stapler "$@" && return 0
        echo "stapler $1 failed (try $i of 4): again in 20 s" >&2
        sleep 20
    done
    xcrun stapler "$@"
}

# The 8-byte id of the minisign key behind a public key or a signature, both
# as Tauri writes them: base64 of a two-line file whose second line is base64
# of two algorithm bytes, the key id, then the key or the signature.
key_id() {
    printf '%s' "$1" | base64 -d | sed -n 2p | base64 -d | xxd -p -s 2 -l 8
}

# Signs one update with the updater key, into <file>.sig, and checks that
# installed copies would accept the signature: same key as in tauri.conf.json.
sign_update() {
    rm -f "$1.sig"
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$PASSWORD" \
        cargo tauri signer sign -f "$UPDATER_KEY" "$1" >/dev/null
    [ -s "$1.sig" ] || die "no signature for $1"
    [ "$(key_id "$(cat "$1.sig")")" = "$TRUSTED_KEY_ID" ] \
        || die "$1 is signed with another key than the one in tauri.conf.json: installed copies would refuse it"
}

upload() {
    [ -f "$OUT/files" ] || die "$OUT/files is missing: run apps/desktop/scripts/release.sh first"
    local files=() f built head
    while IFS= read -r f; do files+=("$OUT/$f"); done < "$OUT/files"
    for f in "${files[@]}" "$OUT/notes.md"; do
        [ -f "$f" ] || die "$f is missing: run apps/desktop/scripts/release.sh first"
    done
    built=$(cat "$OUT/commit")
    head=$(git rev-parse HEAD)
    [ "$built" = "$head" ] || die "$OUT was made from $built, not HEAD ($head)"
    git fetch -q origin
    git branch -r --contains "$head" | grep -q . || die "push $head first: the release's tag points at it"
    if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
        # A published release's files are what people downloaded and what
        # the feed points at: a new build is a new version.
        [ "$(gh release view "$TAG" --repo "$REPO" --json isDraft --jq .isDraft)" = true ] \
            || die "$TAG is published: bump the version for a new build"
        say "Replacing the draft $TAG: files, notes and commit"
        gh release upload "$TAG" --repo "$REPO" --clobber "${files[@]}"
        gh release edit "$TAG" --repo "$REPO" --target "$head" --notes-file "$OUT/notes.md" >/dev/null
    else
        say "Creating the draft release $TAG"
        gh release create "$TAG" --repo "$REPO" --draft --target "$head" \
            --title "$APP_NAME $VERSION" --notes-file "$OUT/notes.md" "${files[@]}"
    fi
    gh release view "$TAG" --repo "$REPO" --json url,isDraft,assets \
        --jq '"\(.url) (draft: \(.isDraft)): \([.assets[].name] | join(", "))"'
}

# The updater's key and its password, and the key id installed copies trust.
load_key() {
    [ -n "${UPDATER_KEY:-}" ] && [ -f "$UPDATER_KEY" ] || die "UPDATER_KEY isn't set to the updater's private key file"
    if [ -n "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" ]; then
        PASSWORD="$TAURI_SIGNING_PRIVATE_KEY_PASSWORD"
    else
        [ -n "${UPDATER_KEY_PASSWORD_ITEM:-}" ] || die "no password for UPDATER_KEY (UPDATER_KEY_PASSWORD_ITEM, or TAURI_SIGNING_PRIVATE_KEY_PASSWORD)"
        PASSWORD=$(security find-generic-password -s "$UPDATER_KEY_PASSWORD_ITEM" -w) \
            || die "can't read the keychain item $UPDATER_KEY_PASSWORD_ITEM"
    fi
    TRUSTED_KEY_ID=$(key_id "$(jq -r .plugins.updater.pubkey apps/desktop/tauri.conf.json)")
    [ -n "$TRUSTED_KEY_ID" ] || die "no updater public key in apps/desktop/tauri.conf.json"
}

# Signs the updates in $OUT and writes latest.json, notes.md and the list of
# files to upload.
sign_all() {
    local mac name url
    mac=$(basename "$MAC_UPDATE")
    sign_update "$MAC_UPDATE"
    for name in "${INSTALLERS[@]}"; do
        sign_update "$OUT/$name"
    done

    # Each copy looks for {os}-{arch}-{installer} first, then {os}-{arch}: one
    # installed from the .deb updates from the .deb.
    url="https://github.com/$REPO/releases/download/$TAG"
    platform() {
        jq -n --arg url "$url/$1" --arg signature "$(cat "$OUT/$1.sig")" '{url: $url, signature: $signature}'
    }
    jq -n --arg version "$VERSION" --arg notes "$NOTES" --arg date "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        --argjson mac "$(platform "$mac")" \
        --argjson nsis "$(platform "$WINDOWS_NSIS")" \
        --argjson msi "$(platform "$WINDOWS_MSI")" \
        --argjson deb "$(platform "$LINUX_DEB")" \
        --argjson rpm "$(platform "$LINUX_RPM")" \
        '{
            version: $version,
            notes: $notes,
            pub_date: $date,
            platforms: {
                "darwin-aarch64": $mac,
                "darwin-x86_64": $mac,
                "windows-x86_64": $nsis,
                "windows-x86_64-nsis": $nsis,
                "windows-x86_64-msi": $msi,
                "linux-x86_64-deb": $deb,
                "linux-x86_64-rpm": $rpm
            }
        }' > "$OUT/latest.json"
    [ "$(jq '[.platforms[] | select(.url | startswith("'"$url"'/")) | select(.signature != "")] | length' "$OUT/latest.json")" = 7 ] \
        || die "latest.json doesn't have seven signed platforms pointing at $TAG"

    printf '%s\n' "$NOTES" > "$OUT/notes.md"
    {
        basename "$DMG"
        echo "$APP_NAME.dmg"
        echo "$mac"
        echo "$mac.sig"
        for name in "${INSTALLERS[@]}"; do
            echo "$name"
            echo "$name.sig"
        done
        echo latest.json
    } > "$OUT/files"
}

# What --unsigned left, signed here: the same commit, so that the notes and
# the trusted key are the ones it was built with.
sign_elsewhere() {
    local name head
    [ -f "$OUT/unsigned" ] || die "$OUT has no build waiting for signatures: run apps/desktop/scripts/release.sh --unsigned first"
    head=$(git rev-parse HEAD)
    [ "$(cat "$OUT/unsigned")" = "$head" ] || die "$OUT was made from $(cat "$OUT/unsigned"), not HEAD ($head)"
    for name in "$(basename "$DMG")" "$APP_NAME.dmg" "$(basename "$MAC_UPDATE")" "${INSTALLERS[@]}"; do
        [ -f "$OUT/$name" ] || die "$OUT/$name is missing"
    done
    for tool in jq cargo xxd; do
        command -v "$tool" >/dev/null || die "$tool is not installed"
    done
    NOTES="$(release_notes)"
    [ -n "$NOTES" ] || die "CHANGELOG.md has no section '## [$VERSION]'"
    load_key
    say "Sign the updates; latest.json"
    sign_all
    echo "$head" > "$OUT/commit"
    rm -f "$OUT/unsigned"
    printf "\n\033[1;32mDone\033[0m\n"
    echo "   Next: apps/desktop/scripts/release.sh --upload   (a draft release $TAG, to read and publish)"
}

UNSIGNED=no
case "${1:-}" in
    --upload) upload; exit 0 ;;
    --sign) sign_elsewhere; exit 0 ;;
    --unsigned) UNSIGNED=yes ;;
    "") ;;
    *) die "unknown option: $1 (--unsigned, --sign or --upload)" ;;
esac

# ---- Preconditions -----------------------------------------------------------

[ -n "${TEAM_ID:-}" ] || die "TEAM_ID is not set (apps/desktop/release.env.example says how)"
have_api_key || [ -n "${NOTARY_PROFILE:-}" ] || die "no notarization credentials (NOTARY_PROFILE, or APPLE_API_KEY_*)"
for tool in gh jq cargo xxd; do
    command -v "$tool" >/dev/null || die "$tool is not installed"
done
cargo tauri --version >/dev/null 2>&1 || die "no Tauri CLI: cargo install tauri-cli --version '^2' --locked"
for target in aarch64-apple-darwin x86_64-apple-darwin; do
    rustup target list --installed | grep -qx "$target" || die "no Rust target $target: rustup target add $target"
done
NOTES="$(release_notes)"
[ -n "$NOTES" ] || die "CHANGELOG.md has no section '## [$VERSION]'"
if [ -n "$(git status --porcelain)" ]; then
    die "the working tree has changes: a release is built from a commit"
fi
HEAD=$(git rev-parse HEAD)

[ "$UNSIGNED" = yes ] || load_key

rm -rf "$OUT"
mkdir -p "$OUT"
# The key and its password, before the long build rather than after it.
if [ "$UNSIGNED" = no ]; then
    echo "$TAG" > "$OUT/key-check"
    sign_update "$OUT/key-check"
    rm -f "$OUT/key-check" "$OUT/key-check.sig"
fi

# ---- 1. The Windows and Linux installers start building ----------------------

say "1/6  Windows and Linux: the $WORKFLOW run for $HEAD"
# The newest run for this commit that hasn't failed: one in progress will do.
find_run() {
    gh run list --repo "$REPO" --workflow "$WORKFLOW" --commit "$HEAD" \
        --json databaseId,status,conclusion \
        --jq '[.[] | select(.status != "completed" or .conclusion == "success")][0].databaseId // empty'
}
RUN=$(find_run)
if [ -z "$RUN" ]; then
    BRANCH=$(git branch --show-current)
    git fetch -q origin
    [ -n "$BRANCH" ] && [ "$(git rev-parse -q --verify "origin/$BRANCH" || true)" = "$HEAD" ] \
        || die "push $HEAD first, on a branch: CI builds the installers from it"
    gh workflow run "$WORKFLOW" --repo "$REPO" --ref "$BRANCH"
    # The run appears a few seconds after it's asked for.
    for _ in $(seq 1 24); do
        sleep 5
        RUN=$(find_run)
        [ -n "$RUN" ] && break
    done
    [ -n "$RUN" ] || die "the $WORKFLOW run didn't start"
fi
echo "   run $RUN: https://github.com/$REPO/actions/runs/$RUN"

# ---- 2. The macOS app --------------------------------------------------------

say "2/6  Build the macOS app: universal, Developer ID"
IDENTITY=$(security find-identity -v -p codesigning \
    | sed -n "s/.*\"\(Developer ID Application: .* ($TEAM_ID)\)\"$/\1/p" | head -1)
[ -n "$IDENTITY" ] || die "no Developer ID Application certificate of team $TEAM_ID in the keychain"
# Tauri notarizes on its own when it sees Apple credentials; here the app and
# then the image are notarized below, so it gets none.
(cd apps/desktop && env -u APPLE_ID -u APPLE_PASSWORD -u APPLE_API_KEY -u APPLE_API_ISSUER \
    -u APPLE_API_KEY_PATH APPLE_SIGNING_IDENTITY="$IDENTITY" \
    cargo tauri build --ci --target universal-apple-darwin --bundles app)
[ -d "$APP" ] || die "the build made no $APP"
SIGNED_BY=$(codesign -dv --verbose=2 "$APP" 2>&1 | sed -n 's/^Authority=\(Developer ID Application: .*\)/\1/p' | head -1)
[ "$SIGNED_BY" = "$IDENTITY" ] || die "the app isn't signed with $IDENTITY (${SIGNED_BY:-not signed})"
# Capture, then test: `codesign | grep -q` fails under pipefail exactly when
# grep finds what it looks for.
flags=$(codesign -dv --verbose=2 "$APP" 2>&1 | grep -o 'flags=0x[0-9a-f]*([^)]*)' || true)
case "$flags" in
    *runtime*) ;;
    *) die "no hardened runtime on $APP (${flags:-no flags}): notarization would refuse it" ;;
esac
EXECUTABLE=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist")
ARCHS=$(lipo -archs "$APP/Contents/MacOS/$EXECUTABLE")
for arch in arm64 x86_64; do
    case " $ARCHS " in
        *" $arch "*) ;;
        *) die "the app isn't universal: $ARCHS" ;;
    esac
done

say "3/6  Notarize and staple the app (usually a few minutes)"
ZIP="$OUT/$APP_NAME.zip"
ditto -c -k --keepParent "$APP" "$ZIP"
notarize "$ZIP"
rm -f "$ZIP"
stapler staple "$APP"
stapler validate "$APP"
spctl -a -vv -t execute "$APP"

say "4/6  Disk image"
STAGE="$OUT/stage"
mkdir -p "$STAGE"
ditto "$APP" "$STAGE/$APP_NAME.app"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "$APP_NAME" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
ls_unregister "$STAGE/$APP_NAME.app"
rm -rf "$STAGE"
# Gatekeeper assesses the image as well as the app in it.
codesign --force --timestamp --sign "$IDENTITY" "$DMG"
notarize "$DMG"
stapler staple "$DMG"
stapler validate "$DMG"

# Checking the image as someone downloading it gets it.
MNT=$(mktemp -d)
hdiutil attach "$DMG" -nobrowse -readonly -quiet -mountpoint "$MNT"
CHECK=$(spctl -a -vv -t execute "$MNT/$APP_NAME.app" 2>&1 || true)
STAPLED=yes
stapler validate "$MNT/$APP_NAME.app" >/dev/null 2>&1 || STAPLED=no
ls_unregister "$MNT/$APP_NAME.app"
hdiutil detach "$MNT" -quiet
rmdir "$MNT" 2>/dev/null || true
echo "$CHECK" | sed 's/^/   /'
case "$CHECK" in
    *"accepted"*"Notarized Developer ID"*) ;;
    *) die "Gatekeeper doesn't accept the app in the image as notarized" ;;
esac
[ "$STAPLED" = yes ] || die "the app in the image has no stapled ticket"
echo "   stapled: yes; architectures: $ARCHS"
cp "$DMG" "$OUT/$APP_NAME.dmg"

# ---- 3. The Windows and Linux installers, built ------------------------------

say "5/6  Windows and Linux: waiting for run $RUN"
gh run watch "$RUN" --repo "$REPO" --exit-status --interval 30 >/dev/null \
    || die "run $RUN failed: gh run view $RUN --repo $REPO --log-failed"
CI="$OUT/ci"
gh run download "$RUN" --repo "$REPO" --dir "$CI"
for name in "${INSTALLERS[@]}"; do
    found=$(find "$CI" -type f -name "$name" | head -1)
    [ -n "$found" ] || die "run $RUN has no $name; it has: $(find "$CI" -type f -exec basename {} \; | tr '\n' ' ')"
    mv "$found" "$OUT/$name"
done
rm -rf "$CI"

# ---- 4. The updates and the feed ---------------------------------------------

# The macOS update is the stapled app itself, packed as the updater expects.
COPYFILE_DISABLE=1 tar -C "$BUNDLE" -czf "$MAC_UPDATE" "$APP_NAME.app"

if [ "$UNSIGNED" = yes ]; then
    echo "$HEAD" > "$OUT/unsigned"
    printf "\n\033[1;32mBuilt, not signed\033[0m\n"
    ls -lh "$OUT" | sed 's/^/   /'
    echo "   Next: copy $OUT to the Mac with the updater's key, at $HEAD, and there"
    echo "   apps/desktop/scripts/release.sh --sign; then, with the files back here, --upload"
    exit 0
fi

say "6/6  Sign the updates; latest.json"
sign_all
echo "$HEAD" > "$OUT/commit"

printf "\n\033[1;32mDone\033[0m\n"
ls -lh "$OUT" | sed 's/^/   /'
echo "   Next: apps/desktop/scripts/release.sh --upload   (a draft release $TAG, to read and publish)"
