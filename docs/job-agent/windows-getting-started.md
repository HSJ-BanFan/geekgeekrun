# Windows getting started

## 1. Download and install

1. Open the repository's GitHub Releases page and select a release whose tag starts with `job-agent-v`.
2. Download `geekgeekrun-job-agent-<version>-win-x64-setup.exe` and `SHA256SUMS.txt`.
3. Verify the installer SHA-256 against `SHA256SUMS.txt`.
4. Run the installer. It installs for the current Windows user without administrator rights and adds only the public launcher directory to the user `PATH`.
5. Close the current terminal and open a new PowerShell or Command Prompt window.

Unsigned `0.x` builds are prereleases. Stable releases are not published until Authenticode signing is configured and verified.

## 2. Verify the installation

```powershell
ggr --version
ggr doctor
ggr-sidecar version
ggr agent version
```

All four commands return JSON. A fresh install can pass `ggr doctor` before browser setup; `checks.browser.reasonCode` will be `BROWSER_NOT_CONFIGURED` and the overall installation can still be healthy.

## 3. Plan a read-only market sample

This command needs no browser, BOSS session, LLM configuration, or Application Authorization:

```powershell
ggr market-jobs --plan-only --keyword "AI Agent" --city "上海" --limit 20
```

The JSON result includes the Cartesian sampling plan, record budget, and absolute artifact paths. Plan-only does not launch a browser or perform any application action.

## 4. Set up the managed browser and log in manually

The normal online path downloads the pinned Chrome for Testing build and verifies its SHA-256 before replacing browser files:

```powershell
ggr setup
```

The browser is visible. Complete BOSS login yourself, then return to the terminal and press Enter. The CLI never accepts an account password or Cookie value.

For a restricted network, download the exact supported browser archive separately and import it:

```powershell
ggr setup --offline-archive C:\Downloads\chrome-win64.zip
```

The archive must match the bundled version and checksum. A mismatch leaves the existing browser and profile intact.

An explicitly selected system browser is also supported when it matches the supported major version:

```powershell
ggr setup --system-browser "C:\Program Files\Google\Chrome\Application\chrome.exe"
```

Automatic browser detection is not authoritative and is not used to silently change the supported baseline.

## 5. Require full browser readiness

```powershell
ggr doctor --require-browser
```

This requires installation integrity, the sidecar, a configured browser, and a known-ready manual BOSS session. If the session has not been checked, run `ggr setup login` in an interactive terminal.

## 6. Run one bounded read-only capture

```powershell
ggr market-jobs --from-browser --keyword "AI Agent" --city "上海" --limit 20 --analyze
```

Default raw and analysis artifacts are stored under `%USERPROFILE%\.geekgeekrun-job-agent\artifacts`. JSON stdout returns absolute paths. Login expiration, safety verification, abnormal environment, and unconfirmed pages stop safely and preserve partial artifacts where applicable.

Recent Application Evidence uses the same managed browser boundary:

```powershell
ggr recent-applications --from-browser --limit 20 --include-jd --analyze
```

Neither command issues or consumes an Application Authorization Token, starts a chat, sends a message, uploads a resume, or applies to a job.

## 7. Discover advanced workflows

```powershell
ggr
ggr-sidecar --help
ggr config path
ggr update check
```

Read the [command reference](command-reference.md) before running controlled-action commands. Installation and sidecar approval do not replace Application Authorization, the Application Authorization Token, Job Identity Anchor, Job Match Guard, confirmation, redaction, or Audit Record requirements.

## 8. Uninstall

Use Windows Settings → Apps → Installed apps → GeekGeekRun Job Agent, or run the installed uninstaller. Default uninstall removes installed runtimes, the user `PATH` entry, managed browser files, browser profile/session state, authorization tokens, temporary state, and isolated mutable data. It preserves configuration, redacted Audit Records, and artifacts.

For complete removal, run the uninstaller with the explicit option:

```powershell
& "$env:LOCALAPPDATA\Programs\GeekGeekRun Job Agent\unins000.exe" /GGRREMOVEALL=1
```

This deletes `%USERPROFILE%\.geekgeekrun-job-agent` in full. It does not mutate the desktop app's `%USERPROFILE%\.geekgeekrun` state.
