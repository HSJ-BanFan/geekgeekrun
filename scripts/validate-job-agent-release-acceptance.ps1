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
    [string]$InstallerSha256
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
if ($body -match "(?m)^- \[ \]") {
    throw "RELEASE_ACCEPTANCE_CHECKLIST_INCOMPLETE: $($record.url)"
}
if ($body -match "pass\s*/\s*fail|pass\s*/\s*not applicable|online\s*/\s*offline|clean VM\s*/\s*dedicated machine|<version>") {
    throw "RELEASE_ACCEPTANCE_PLACEHOLDER_REMAINS: $($record.url)"
}

[ordered]@{
    ok = $true
    command = "validate-job-agent-release-acceptance"
    issueNumber = $record.number
    recordUrl = $record.url
    releaseTag = $ReleaseTag
    distributionVersion = $DistributionVersion
    installerSha256 = $expectedHash
} | ConvertTo-Json -Depth 3
