# Security

MagnetCut opens files you give it and writes the ones you export, so a bug that reads or writes
anything else matters. So does any network traffic you didn't ask for.

## Reporting

Please report vulnerabilities privately through GitHub: **Security → Report a vulnerability** on
this repository. Don't open a public issue.

Include what you did, on which system and version, and what happened. You'll get a reply within
a few days. Only the latest release gets fixes.

## Scope

- Reading, writing or deleting files the user didn't choose.
- Network traffic (downloads or uploads) the user didn't ask for. The app has no telemetry; any
  outbound data about the user or their media is a bug.
- An update installing anything not signed with the project's key.
- Media files that crash the app or run code when opened.
