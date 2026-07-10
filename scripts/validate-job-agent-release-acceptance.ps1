param(
    [Parameter(Mandatory = $true)]
    [string]$Repository,
    [Parameter(Mandatory = $true)]
    [int]$IssueNumber,
    [Parameter(Mandatory = $true)]
    [string]$ReleaseTag,
    [Parameter(Mandatory = $true)]
    [string]$DistributionVersion,
    [Parameter(Mandatory = $true)]
    [string]$InstallerSha256,
    [Parameter(Mandatory = $true)]
    [long]$CandidateRunId
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$record = gh issue view $IssueNumber --repo $Repository --json number,title,body,state,url | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $null -eq $record) {
    throw "RELEASE_ACCEPTANCE_RECORD_NOT_FOUND"
}
$body = [string]$record.body
$expectedHash = $InstallerSha256.ToLowerInvariant()

if ([string]$record.state -ne "CLOSED") {
    throw "RELEASE_ACCEPTANCE_RECORD_NOT_CLOSED: $($record.url)"
}
if ($body -notmatch "(?m)^- Distribution version:\s*$([regex]::Escape($DistributionVersion))\s*$" -or
    $body -notmatch "(?m)^- Release tag:\s*$([regex]::Escape($ReleaseTag))\s*$" -or
    $body -notmatch "(?mi)^- Installer SHA-256:\s*$([regex]::Escape($expectedHash))\s*$" -or
    $body -notmatch "(?mi)^- Installer SHA-256 verified:\s*pass\s*$" -or
    $body -notmatch "(?mi)^- Final outcome:\s*pass\s*$") {
    throw "RELEASE_ACCEPTANCE_IDENTITY_OR_OUTCOME_INVALID: $($record.url)"
}
if ($CandidateRunId -le 0 -or $body -notmatch "(?m)^- Candidate workflow run ID:\s*$CandidateRunId\s*$") {
    throw "RELEASE_ACCEPTANCE_CANDIDATE_RUN_INVALID: $($record.url)"
}
if ($body -match "(?m)^- \[ \]") {
    throw "RELEASE_ACCEPTANCE_CHECKLIST_INCOMPLETE: $($record.url)"
}
if ($body -match "pass\s*/\s*fail|pass\s*/\s*not applicable|online\s*/\s*offline|clean VM\s*/\s*dedicated machine|<version>") {
    throw "RELEASE_ACCEPTANCE_PLACEHOLDER_REMAINS: $($record.url)"
}
if ($body -match "(?mi)^- Related issues to close:\s*$") {
    throw "RELEASE_ACCEPTANCE_RELATED_ISSUES_UNRESOLVED: $($record.url)"
}

$requiredMetadata = @(
    "Windows edition and build",
    "Browser product and version",
    "Test environment",
    "Operator",
    "Started at \(UTC\)",
    "Completed at \(UTC\)"
)
foreach ($labelPattern in $requiredMetadata) {
    if ($body -notmatch "(?mi)^- $($labelPattern):[ \t]*\S[^\r\n]*$") {
        throw "RELEASE_ACCEPTANCE_REQUIRED_METADATA_MISSING: $($record.url)"
    }
}

$requiredChecklistFragments = @(
    "Per-user install completed without elevation",
    "newly opened terminal resolved",
    "ggr --version",
    "ggr doctor",
    "ggr market-jobs --plan-only",
    "Managed browser setup completed",
    "BOSS login was completed manually",
    "ggr doctor --require-browser",
    "bounded read-only Market Job Evidence crawl",
    "Returned artifacts were inspected",
    "Default uninstall removed the product",
    "Configuration, redacted Audit Records, and artifacts were preserved",
    "Complete-removal mode deleted",
    "Desktop app state remained unchanged"
)
foreach ($fragment in $requiredChecklistFragments) {
    if ($body -notmatch "(?mi)^- \[[xX]\][^\r\n]*$([regex]::Escape($fragment))") {
        throw "RELEASE_ACCEPTANCE_REQUIRED_CHECK_MISSING: $fragment"
    }
}

function Get-RequiredOutcome([string]$LabelPattern, [string]$DisplayLabel) {
    $match = [regex]::Match($body, "(?mi)^- $($LabelPattern):\s*(?<value>.+?)\s*$")
    if (-not $match.Success) {
        throw "RELEASE_ACCEPTANCE_REQUIRED_OUTCOME_MISSING: $DisplayLabel"
    }
    return $match.Groups["value"].Value.Trim()
}

$rationaleOutcomes = @(
    @{ Pattern = [regex]::Escape("Login expiration"); Label = "Login expiration" },
    @{ Pattern = [regex]::Escape("Safety verification stop"); Label = "Safety verification stop" },
    @{ Pattern = 'Competing process returned\s+`?BROWSER_PROFILE_IN_USE`?'; Label = "Competing process returned BROWSER_PROFILE_IN_USE" }
)
foreach ($outcome in $rationaleOutcomes) {
    $value = Get-RequiredOutcome $outcome.Pattern $outcome.Label
    if ($value -match "(?i)^pass\b") { continue }
    if ($value -match "(?i)^not applicable\b") {
        if ($value -notmatch "(?i)(?:Reason/rationale|Rationale):\s*\S") {
            throw "RELEASE_ACCEPTANCE_NOT_APPLICABLE_RATIONALE_MISSING: $($outcome.Label)"
        }
        continue
    }
    throw "RELEASE_ACCEPTANCE_REQUIRED_OUTCOME_INVALID: $($outcome.Label)"
}

$passOutcomes = @(
    "Plan-only remained usable while the managed browser profile was locked",
    "No Application Authorization Token was issued or consumed by read-only capture",
    "No chat, greeting, upload, application, or verification-bypass action occurred"
)
foreach ($label in $passOutcomes) {
    if ((Get-RequiredOutcome ([regex]::Escape($label)) $label) -notmatch "(?i)^pass\b") {
        throw "RELEASE_ACCEPTANCE_REQUIRED_OUTCOME_INVALID: $label"
    }
}

[ordered]@{
    ok = $true
    command = "validate-job-agent-release-acceptance"
    issueNumber = $record.number
    recordUrl = $record.url
    releaseTag = $ReleaseTag
    distributionVersion = $DistributionVersion
    installerSha256 = $expectedHash
    candidateRunId = $CandidateRunId
} | ConvertTo-Json -Depth 3
