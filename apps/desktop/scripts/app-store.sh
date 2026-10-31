#!/bin/bash
#
# MagnetCut for the Mac App Store: builds the App Store edition (universal,
# sandboxed, without the updater: the App Store updates its own apps), signs
# it for the store, wraps it in an installer package, has App Store Connect
# validate it, and with --upload sends it there.
#
#   apps/desktop/scripts/app-store.sh            target/app-store/MagnetCut-<version>-<build>.pkg, validated
#   apps/desktop/scripts/app-store.sh --upload   and upload it, as a new build of the app
#   STORE_BUILD=1 apps/desktop/scripts/app-store.sh --upload
#                                                another upload of the same version (App
#                                                Store Connect takes each build number once):
#                                                0.1.0's second build is 0.1.1
#
# Needs, in apps/desktop/release.env (see release.env.example):
#   TEAM_ID                the team's id
#   APP_STORE_BUNDLE_ID    the bundle id registered for the store edition (not the
#                          direct download's: the two keep apart)
#   APP_STORE_PROFILE      its Mac App Store provisioning profile
#   ASC_KEY_JSON           an App Store Connect API key's details, as JSON
#                          ({"key_id", "issuer_id", "key_filepath"}), or
#                          APPLE_API_KEY_ID and APPLE_API_ISSUER, with the key in
#                          ~/.appstoreconnect/private_keys/AuthKey_<id>.p8
# and, in the login keychain, the team's "Apple Distribution" and "Mac
# Installer Distribution" (or "3rd Party Mac Developer Installer") identities.
#
# The app record must exist in App Store Connect first (Apps → New App; the
# API can't create one). The upload adds a build; the listing, and submitting
# it for review, happen there.
#
set -euo pipefail
DESKTOP="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$DESKTOP/../.." && pwd)"
cd "$ROOT"

APP_NAME=MagnetCut
OUT=target/app-store
BUNDLE=target/universal-apple-darwin/release/bundle/macos

say() { printf "\n\033[1;34m==>\033[0m %s\n" "$*"; }
die() { printf "\n\033[1;31mERROR:\033[0m %s\n" "$*" >&2; exit 1; }

UPLOAD=false
for arg in "$@"; do
    case "$arg" in
        --upload) UPLOAD=true ;;
        *) die "unknown option: $arg (the only one is --upload)" ;;
    esac
done

[ -f "$DESKTOP/release.env" ] && source "$DESKTOP/release.env"
: "${TEAM_ID:?set TEAM_ID in apps/desktop/release.env}"
: "${APP_STORE_BUNDLE_ID:?set APP_STORE_BUNDLE_ID in apps/desktop/release.env}"
: "${APP_STORE_PROFILE:?set APP_STORE_PROFILE in apps/desktop/release.env}"
PROFILE="${APP_STORE_PROFILE/#\~/$HOME}"
[ -f "$PROFILE" ] || die "no provisioning profile at $PROFILE"

# The API key, without ever printing it.
if [ -n "${ASC_KEY_JSON:-}" ]; then
    json="${ASC_KEY_JSON/#\~/$HOME}"
    APPLE_API_KEY_ID="$(plutil -extract key_id raw "$json")"
    APPLE_API_ISSUER="$(plutil -extract issuer_id raw "$json")"
fi
: "${APPLE_API_KEY_ID:?set ASC_KEY_JSON, or APPLE_API_KEY_ID and APPLE_API_ISSUER, in apps/desktop/release.env}"
: "${APPLE_API_ISSUER:?set APPLE_API_ISSUER in apps/desktop/release.env}"
[ -f "$HOME/.appstoreconnect/private_keys/AuthKey_$APPLE_API_KEY_ID.p8" ] \
    || die "the API key must be at ~/.appstoreconnect/private_keys/AuthKey_<key id>.p8, where altool looks"

identity() {
    security find-identity -v -p basic 2>/dev/null | grep -E "\"($1): .*\\($TEAM_ID\\)\"" | head -1 \
        | sed 's/.*"\(.*\)"/\1/' || true
}
SIGN_APP="$(identity "Apple Distribution")"
SIGN_PKG="$(identity "Mac Installer Distribution|3rd Party Mac Developer Installer")"
[ -n "$SIGN_APP" ] || die "no Apple Distribution identity for team $TEAM_ID in the keychain"
[ -n "$SIGN_PKG" ] || die "no Mac Installer Distribution identity for team $TEAM_ID in the keychain"

if [ -n "$(git status --porcelain)" ]; then
    die "the working tree has changes: a build is made from a commit"
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# The profile must be for this app and this team.
security cms -D -i "$PROFILE" > "$WORK/profile.plist"
[ "$(plutil -extract Entitlements.com\\.apple\\.application-identifier raw "$WORK/profile.plist")" = "$TEAM_ID.$APP_STORE_BUNDLE_ID" ] \
    || die "$PROFILE isn't the Mac App Store profile for $TEAM_ID.$APP_STORE_BUNDLE_ID"

VERSION=$(sed -n 's/^version = "\(.*\)"/\1/p' apps/desktop/Cargo.toml | head -1)
# A Mac build number is at most three numbers, each build sent to the store
# higher than every one before it: x.y.(z*100 + n) for the nth rebuild of
# x.y.z (STORE_BUILD, 0 unless set) stays below x.y.(z+1)'s first.
STORE_BUILD="${STORE_BUILD:-0}"
[[ "$STORE_BUILD" =~ ^[0-9]{1,2}$ ]] || die "STORE_BUILD is a number from 0 to 99"
IFS=. read -r MAJOR MINOR PATCH <<< "$VERSION"
[[ "$MAJOR.$MINOR.$PATCH" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "the version $VERSION isn't x.y.z"
BUILD="${BUILD_NUMBER:-$MAJOR.$MINOR.$((10#$PATCH * 100 + 10#$STORE_BUILD))}"

# The store wants the app's entitlements plus who it is, as the profile grants.
ENT="$WORK/AppStore.entitlements"
cp apps/desktop/AppStore.entitlements "$ENT"
plutil -insert com\\.apple\\.application-identifier -string "$TEAM_ID.$APP_STORE_BUNDLE_ID" "$ENT"
plutil -insert com\\.apple\\.developer\\.team-identifier -string "$TEAM_ID" "$ENT"
# Readable by all: the installer makes every file root's.
chmod 644 "$ENT"
cp "$PROFILE" "$WORK/embedded.provisionprofile"
chmod 644 "$WORK/embedded.provisionprofile"

# What the store edition changes in tauri.conf.json.
jq -n --arg id "$APP_STORE_BUNDLE_ID" --arg ent "$ENT" --arg profile "$WORK/embedded.provisionprofile" \
    --arg build "$BUILD" '{
        identifier: $id,
        bundle: { macOS: {
            entitlements: $ent,
            files: { "embedded.provisionprofile": $profile },
            bundleVersion: $build
        } }
    }' > "$WORK/app-store.conf.json"

say "Building the App Store edition $VERSION ($BUILD), universal, signed as: $SIGN_APP"
# Without the updater (--no-default-features), and no notarization: the store
# checks the app itself.
(
    cd apps/desktop
    env -u APPLE_ID -u APPLE_PASSWORD -u APPLE_API_KEY -u APPLE_API_KEY_PATH -u APPLE_API_ISSUER \
        APPLE_SIGNING_IDENTITY="$SIGN_APP" \
        cargo tauri build --ci --target universal-apple-darwin --bundles app \
        --config "$WORK/app-store.conf.json" -- --no-default-features
)
rm -rf "$OUT"
mkdir -p "$OUT"
ditto "$BUNDLE/$APP_NAME.app" "$OUT/$APP_NAME.app"
APP="$OUT/$APP_NAME.app"
CONTENTS="$APP/Contents"

say "Checking the app"
[ "$(plutil -extract CFBundleIdentifier raw "$CONTENTS/Info.plist")" = "$APP_STORE_BUNDLE_ID" ] \
    || die "the bundle id isn't $APP_STORE_BUNDLE_ID"
[ "$(plutil -extract CFBundleVersion raw "$CONTENTS/Info.plist")" = "$BUILD" ] \
    || die "the build number isn't $BUILD"
[ -f "$CONTENTS/embedded.provisionprofile" ] || die "the provisioning profile isn't in the app"
[ -f "$CONTENTS/Resources/Assets.car" ] \
    || die "no Assets.car: the icon went in as an .icns, which macOS 26 frames in grey (needs Xcode 26's actool)"
# Capture, then test: `command | grep -q` fails under pipefail exactly when
# grep finds what it looks for, as it stops reading before the command is done.
archs=" $(lipo -archs "$CONTENTS/MacOS/magnetcut") "
[[ "$archs" == *" arm64 "* && "$archs" == *" x86_64 "* ]] || die "the app isn't universal"
updater=$(strings "$CONTENTS/MacOS/magnetcut" | grep -c "plugin:updater" || true)
[ "$updater" = 0 ] || die "the updater is in the App Store edition"
codesign --verify --deep --strict "$APP"
signature=$(codesign -d --verbose=2 "$APP" 2>&1)
[[ "$signature" == *"Authority=$SIGN_APP"* ]] || die "not signed as $SIGN_APP"
entitlements=$(codesign -d --entitlements - --xml "$APP" 2>/dev/null)
[[ "$entitlements" == *com.apple.security.app-sandbox* ]] || die "the app isn't sandboxed"
# A quarantine flag anywhere in the package is rejected after the upload.
quarantined=$(xattr -rl "$APP" | grep -c com.apple.quarantine || true)
[ "$quarantined" = 0 ] || die "a file in the app is quarantined"
# Installed, everything is root's: what others can't read, nobody can check
# the signature of, and App Store Connect refuses the package.
private="$(find "$APP" \( -type d ! -perm -o+rx \) -o \( ! -type d ! -perm -o+r \))"
[ -z "$private" ] || die "only root could read these once installed: $private"

PKG="$OUT/$APP_NAME-$VERSION-$BUILD.pkg"
say "Packaging, signed as: $SIGN_PKG"
productbuild --component "$APP" /Applications --sign "$SIGN_PKG" "$PKG"
pkgutil --check-signature "$PKG" | head -3

KEY=(--apiKey "$APPLE_API_KEY_ID" --apiIssuer "$APPLE_API_ISSUER")
ALTOOL_LOG="$WORK/altool.log"
# altool exits 0 when App Store Connect refuses the package: what it says on
# success is the only evidence.
altool() { # what it says on success, then its arguments
    local ok="$1"
    shift
    xcrun altool "$@" 2>&1 | tee "$ALTOOL_LOG" || true
    grep -q "$ok" "$ALTOOL_LOG" || die "App Store Connect refused the package (above)"
}

say "Validating with App Store Connect"
altool "No errors validating archive" --validate-app -f "$PKG" -t macos "${KEY[@]}"

if $UPLOAD; then
    say "Uploading $VERSION ($BUILD)"
    altool "No errors uploading archive" --upload-app -f "$PKG" -t macos "${KEY[@]}"
    say "Uploaded. It shows in App Store Connect once it's processed, usually within the hour."
else
    say "Validated: $PKG. apps/desktop/scripts/app-store.sh --upload sends it."
fi
