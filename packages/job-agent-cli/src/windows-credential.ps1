param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("set", "get", "delete", "exists")]
    [string]$Action,
    [Parameter(Mandatory = $true)]
    [string]$Target
)

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class GgrCredentialManager
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct Credential
    {
        public UInt32 Flags;
        public UInt32 Type;
        public IntPtr TargetName;
        public IntPtr Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public UInt32 CredentialBlobSize;
        public IntPtr CredentialBlob;
        public UInt32 Persist;
        public UInt32 AttributeCount;
        public IntPtr Attributes;
        public IntPtr TargetAlias;
        public IntPtr UserName;
    }

    [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CredWrite(ref Credential credential, UInt32 flags);

    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credentialPtr);

    [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CredDelete(string target, UInt32 type, UInt32 flags);

    [DllImport("advapi32.dll")]
    public static extern void CredFree(IntPtr buffer);
}
"@

$credentialTypeGeneric = [uint32]1
$credentialPersistLocalMachine = [uint32]2

function Read-CredentialSecret {
    param([string]$CredentialTarget)

    $credentialPointer = [IntPtr]::Zero
    $read = [GgrCredentialManager]::CredRead(
        $CredentialTarget,
        $credentialTypeGeneric,
        0,
        [ref]$credentialPointer
    )
    if (-not $read) {
        $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        if ($errorCode -eq 1168) {
            return $null
        }
        throw "CREDENTIAL_READ_FAILED:$errorCode"
    }
    try {
        $credential = [Runtime.InteropServices.Marshal]::PtrToStructure(
            $credentialPointer,
            [type][GgrCredentialManager+Credential]
        )
        if ($credential.CredentialBlobSize -eq 0) {
            return ""
        }
        $bytes = New-Object byte[] $credential.CredentialBlobSize
        [Runtime.InteropServices.Marshal]::Copy(
            $credential.CredentialBlob,
            $bytes,
            0,
            $credential.CredentialBlobSize
        )
        return [Text.Encoding]::Unicode.GetString($bytes)
    } finally {
        [GgrCredentialManager]::CredFree($credentialPointer)
    }
}

if ($Action -eq "set") {
    $secret = [Console]::In.ReadToEnd()
    $secretBytes = [Text.Encoding]::Unicode.GetBytes($secret)
    if ($secretBytes.Length -gt 512) {
        throw "CREDENTIAL_SECRET_TOO_LARGE"
    }
    $targetPointer = [Runtime.InteropServices.Marshal]::StringToCoTaskMemUni($Target)
    $userPointer = [Runtime.InteropServices.Marshal]::StringToCoTaskMemUni("GeekGeekRun Job Agent")
    $secretPointer = [Runtime.InteropServices.Marshal]::AllocCoTaskMem($secretBytes.Length)
    try {
        if ($secretBytes.Length -gt 0) {
            [Runtime.InteropServices.Marshal]::Copy($secretBytes, 0, $secretPointer, $secretBytes.Length)
        }
        $credential = New-Object GgrCredentialManager+Credential
        $credential.Type = $credentialTypeGeneric
        $credential.TargetName = $targetPointer
        $credential.CredentialBlobSize = $secretBytes.Length
        $credential.CredentialBlob = $secretPointer
        $credential.Persist = $credentialPersistLocalMachine
        $credential.UserName = $userPointer
        if (-not [GgrCredentialManager]::CredWrite([ref]$credential, 0)) {
            $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
            throw "CREDENTIAL_WRITE_FAILED:$errorCode"
        }
    } finally {
        [Runtime.InteropServices.Marshal]::FreeCoTaskMem($targetPointer)
        [Runtime.InteropServices.Marshal]::FreeCoTaskMem($userPointer)
        [Runtime.InteropServices.Marshal]::FreeCoTaskMem($secretPointer)
    }
    @{ ok = $true; exists = $true } | ConvertTo-Json -Compress
    exit 0
}

if ($Action -eq "get") {
    $secret = Read-CredentialSecret -CredentialTarget $Target
    if ($null -eq $secret) {
        @{ ok = $false; exists = $false; reasonCode = "CREDENTIAL_NOT_FOUND" } | ConvertTo-Json -Compress
        exit 1
    }
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($secret))
    @{ ok = $true; exists = $true; secretBase64 = $encoded } | ConvertTo-Json -Compress
    exit 0
}

if ($Action -eq "exists") {
    $secret = Read-CredentialSecret -CredentialTarget $Target
    @{ ok = $true; exists = ($null -ne $secret) } | ConvertTo-Json -Compress
    exit 0
}

if ($Action -eq "delete") {
    $deleted = [GgrCredentialManager]::CredDelete($Target, $credentialTypeGeneric, 0)
    if (-not $deleted) {
        $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        if ($errorCode -ne 1168) {
            throw "CREDENTIAL_DELETE_FAILED:$errorCode"
        }
    }
    @{ ok = $true; exists = $false } | ConvertTo-Json -Compress
}
