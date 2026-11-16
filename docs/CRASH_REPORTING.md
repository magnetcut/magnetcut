# Crash reporting

Sentry receives errors only after **Settings → Send crash reports** is enabled.
It is off by default. The desktop app needs a restart after enabling it; turning
it off stops new events immediately. An upload already in flight may complete.
Development builds and `MAGNETCUT_PROBE` runs do not report by default.

Projects in the `salamacchine` organization:

- `magnetcut-desktop` (`rust`): Rust panics and native minidumps, including faults
  in libraries loaded into MagnetCut's process.
- `magnetcut-web` (`javascript-nextjs`): uncaught frontend exceptions, rejected
  promises, and React render errors in the static frontend.

Tracing, replays, analytics, logs, metrics and automatic session reporting are
not enabled. Browser click/console/network breadcrumbs are excluded. Default
personal-data collection is disabled; errors can still contain application data
in their messages, and native minidumps can contain memory fragments. No project
files or media are deliberately attached. Do not describe minidumps as anonymous.

## Release configuration

The public DSNs are build-time configuration:

- `MAGNETCUT_SENTRY_DSN`: Rust/native project DSN, embedded by Cargo.
- `NEXT_PUBLIC_SENTRY_DSN`: frontend project DSN, embedded by Next.js.
- `SENTRY_RELEASE` and `NEXT_PUBLIC_SENTRY_RELEASE`: the same `magnetcut@<commit>`.
- `SENTRY_ORG=salamacchine`, `SENTRY_PROJECT_WEB=magnetcut-web`.
- `SENTRY_AUTH_TOKEN`: build-only organization token with `org:ci` scope. Never
  expose it through `NEXT_PUBLIC_*` or commit it.

For GitHub release builds, configure repository variables `MAGNETCUT_SENTRY_DSN`
and `NEXT_PUBLIC_SENTRY_DSN`, and repository secret `SENTRY_AUTH_TOKEN`. The
workflow supplies the organization, project and matching release identifiers.
For local macOS releases, export the variables from the ignored
`apps/desktop/release.env` (see its example). The release script sets the release
identifier and uploads both architectures' dSYMs. The App Store build is not
configured automatically; review its privacy disclosures before enabling DSNs.

`withSentryConfig` uploads frontend source maps during a build with an auth token.
The release workflow uploads native symbols and source context, and retains
native symbol artifacts for 90 days. Keep symbols for older supported releases
before those artifacts expire. Debug information is generated for optimized
Rust releases. The upload token is optional for local builds; without it reports
may lack source context until the matching symbols/maps are uploaded.

## Linux

WebKit uses a separate web process. MagnetCut records its abnormal termination
and reason, but the native SDK does **not** capture a minidump from that process.
Use the system core collector for its native stack. OOM kills and hangs may not
produce any core; check kernel logs or attach a debugger to a hanging process.

On machines using `systemd-coredump`:

```sh
ulimit -c unlimited
RUST_BACKTRACE=full magnetcut 2>&1 | tee magnetcut.log
coredumpctl list --since today
coredumpctl info PID
coredumpctl debug PID
coredumpctl dump PID --output=magnetcut.core
```

In GDB: `thread apply all bt full`. Select the crashed PID, which may belong to
WebKit rather than MagnetCut. Install matching system-library debug symbols or
use the distro's debuginfod service. Keep full cores local unless specifically
needed for an investigation; they can contain sensitive data and be very large.

The reporting preference is in the platform config directory, beneath the app's
bundle identifier, in `crash-reporting`. Temporary minidumps use the sibling
`crashes` directory. Missing or malformed consent files disable reporting.

## Verification

Use a throwaway profile and the `test` Sentry environment. Native debug builds
require `MAGNETCUT_SENTRY_TEST=1`; `MAGNETCUT_SENTRY_TEST_CONFIG_DIR` can point at
a temporary directory to avoid changing the user's preference. Web development
verification requires `NEXT_PUBLIC_SENTRY_TEST=1`. Neither switch enables consent
by itself. Leave the frontend test flag unset for production builds.

Trigger a temporary error through the app, confirm the issue and readable stack
in each project, and remove the trigger. Test a native crash on Linux as well as
a Rust panic: they exercise different reporting paths. Never deliberately crash
a session with unsaved work.

For the free plan, monitor the organization's shared error and attachment
quotas. Repeated occurrences consume error quota even when grouped into one
issue. Leave retention of raw crash attachments disabled unless downloadable
minidumps are needed; processing the stack does not require keeping them.
