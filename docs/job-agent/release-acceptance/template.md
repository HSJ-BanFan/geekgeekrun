# Job Agent <version> Windows x64 acceptance

## Record metadata

- Distribution version:
- Release tag:
- Installer SHA-256 verified: pass / fail
- Windows edition and build:
- Browser product and version:
- Test environment: clean VM / dedicated machine
- Operator:
- Started at (UTC):
- Completed at (UTC):

## Supported user path

- [ ] Per-user install completed without elevation.
- [ ] A newly opened terminal resolved `ggr` and `ggr-sidecar` from user `PATH`.
- [ ] `ggr --version`, `ggr-sidecar version`, and `ggr agent version` reported one distribution version.
- [ ] `ggr doctor` passed installation integrity before browser setup.
- [ ] `ggr market-jobs --plan-only --keyword "AI Agent" --city "上海" --limit 5` returned valid JSON.
- [ ] Managed browser setup completed through: online / offline verified archive.
- [ ] BOSS login was completed manually in the visible managed browser.
- [ ] `ggr doctor --require-browser` reported browser and session readiness.
- [ ] One bounded read-only Market Job Evidence crawl completed with `--limit 5` or lower.
- [ ] Returned artifacts were inspected and contained no Cookie/API-key/raw-browser-state values.

## Safe-stop and isolation checks

- Login expiration: pass / not applicable. Reason/rationale:
- Safety verification stop: pass / not applicable. Reason/rationale:
- Competing process returned `BROWSER_PROFILE_IN_USE`: pass / not applicable. Reason/rationale:
- Plan-only remained usable while the managed browser profile was locked: pass / fail
- No Application Authorization Token was issued or consumed by read-only capture: pass / fail
- No chat, greeting, upload, application, or verification-bypass action occurred: pass / fail

## Uninstall

- [ ] Default uninstall removed the product, PATH entry, browser/profile state, tokens, temp, and isolated mutable data.
- [ ] Configuration, redacted Audit Records, and artifacts were preserved.
- [ ] Complete-removal mode deleted the remaining Job Agent runtime home in a separate disposable check.
- [ ] Desktop app state remained unchanged.

## Non-sensitive notes

- Final outcome: pass / fail
- Stable reason codes observed:
- Follow-up issues:
