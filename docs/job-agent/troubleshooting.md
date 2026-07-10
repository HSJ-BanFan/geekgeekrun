# Job Agent troubleshooting

Start with:

```powershell
ggr doctor
ggr config validate
```

## Installation and integrity

- `INSTALL_MANIFEST_NOT_FOUND`, `INSTALL_MANIFEST_INVALID`: reinstall from the official Job Agent installer.
- `INSTALLATION_INTEGRITY_FAILED`, `COMPONENT_HASH_MISMATCH`, `COMPONENT_FILE_MISSING`: reinstall the complete release and verify its SHA-256; do not mix individual runtime files.
- `DISTRIBUTION_VERSION_MISMATCH`, `CONTRACT_VERSION_MISMATCH`: components from different releases were mixed.
- `SIDECAR_NOT_READY`: reinstall; `ggr-sidecar` is part of the same installer and is not a separate operator-side pip package.

## Browser provisioning

- `BROWSER_DOWNLOAD_FAILED`: check network/proxy access, then retry or use the exact supported offline archive.
- `BROWSER_ARCHIVE_HASH_MISMATCH`: the archive is wrong, incomplete, or modified. Existing browser files/profile are preserved.
- `BROWSER_ARCHIVE_LAYOUT_INVALID`: use the official Chrome for Testing win64 archive named by the release.
- `BROWSER_VERSION_UNSUPPORTED`: select a browser matching the supported major version. Automatic detection does not override the baseline.
- `BROWSER_METADATA_OVERRIDE_FORBIDDEN`: installed setup always trusts the browser metadata shipped in the integrity-verified installation; use the exact supported archive instead of replacement metadata.
- `BROWSER_EXECUTABLE_MISSING`: run `ggr setup repair`; repair preserves the browser profile.

## Login and profile state

- `INTERACTIVE_LOGIN_REQUIRED`: run `ggr setup login` in a real terminal, not redirected CI input.
- `BOSS_SESSION_NOT_READY`, `BOSS_LOGIN_REQUIRED`: complete BOSS login manually in the visible managed browser.
- `BOSS_SESSION_UNCONFIRMED`: open a supported BOSS geek page and confirm that authenticated navigation/workspace controls are visible, then rerun `ggr setup login`.
- `BOSS_SAFETY_VERIFICATION_REQUIRED`, `BOSS_ABNORMAL_ENVIRONMENT`: stop and complete the platform's visible safety process yourself. The CLI does not bypass verification.
- `BROWSER_PROFILE_IN_USE`: another managed browser command owns the profile. Let it finish; offline planning and artifact analysis remain available.
- `PROFILE_RESET_CONFIRMATION_REQUIRED`: profile reset logs the managed session out and requires `ggr setup reset-profile --confirm`.

The normal setup path never accepts passwords or Cookie values and never prints Cookies or browser credentials.

## CDP connection

- `REMOTE_CDP_REJECTED`: the default accepts only loopback endpoints. Use a local endpoint or add `--allow-remote-cdp` only in a reviewed advanced environment.
- `CDP_ENDPOINT_CREDENTIALS_FORBIDDEN`: remove username/password material from the URL. Endpoint secrets must not enter shell history.
- `CDP_ENDPOINT_INVALID`, `CDP_ENDPOINT_PROTOCOL_UNSUPPORTED`: use HTTP(S) or WS(S).

## Configuration and Credential Manager

- `CONFIG_NOT_INITIALIZED`: run `ggr config init`.
- `CONFIG_INVALID`: inspect the listed file and reason code; paths are available from `ggr config path`.
- `LLM_PLAINTEXT_SECRET_FORBIDDEN`: remove `apiKey` or `providerApiSecret` from `llm.json` and use `ggr config secret set --name <name>`.
- `CREDENTIAL_REFERENCE_INVALID`, `CREDENTIAL_TARGET_INVALID`: use only references created by `ggr config secret`; valid targets stay under `GeekGeekRun/JobAgent/<name>`.
- `INTERACTIVE_SECRET_REQUIRED`: run `ggr config secret set --name <name>` interactively.
- `CREDENTIAL_STORE_UNAVAILABLE`, `CREDENTIAL_STORE_OPERATION_FAILED`: verify the intended Windows user and Windows Credential Manager availability.
- Missing advanced LLM configuration does not block setup, doctor, plan-only, or read-only market sampling.

Never place API keys in command arguments, ordinary configuration JSON, artifacts, or Audit Records.

## Update checks

- `UPDATE_CHECK_NETWORK_FAILED`, `UPDATE_CHECK_HTTP_FAILED`: retry later. The explicit read-only failure does not affect ordinary commands.
- `JOB_AGENT_RELEASE_NOT_FOUND`: no matching `job-agent-v*` release was found.

The first release line does not auto-update and ordinary commands do not perform startup update checks.

## Uninstall

Default uninstall preserves configuration, redacted Audit Records, and artifacts while deleting browser/session state, tokens, temporary state, and isolated mutable data. Use `/GGRREMOVEALL=1` only when complete erasure is intended. Desktop app state under `%USERPROFILE%\.geekgeekrun` is separate.
