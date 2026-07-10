#ifndef BundleRoot
  #error BundleRoot define is required
#endif
#ifndef OutputDir
  #error OutputDir define is required
#endif
#ifndef DistributionVersion
  #error DistributionVersion define is required
#endif

#define ProductName "GeekGeekRun Job Agent"
#define ProductPublisher "GeekGeekRun"
#define ProductUrl "https://github.com/HSJ-BanFan/geekgeekrun"

[Setup]
AppId={{D9F2BCE8-FCDF-4EE2-9BEE-7C2BA27D51A6}
AppName={#ProductName}
AppVersion={#DistributionVersion}
AppPublisher={#ProductPublisher}
AppPublisherURL={#ProductUrl}
AppSupportURL={#ProductUrl}/issues
DefaultDirName={localappdata}\Programs\GeekGeekRun Job Agent
DefaultGroupName={#ProductName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutputDir}
OutputBaseFilename=geekgeekrun-job-agent-{#DistributionVersion}-win-x64-setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName={#ProductName} {#DistributionVersion}
UninstallDisplayIcon={app}\runtime\node.exe
ChangesEnvironment=yes
CloseApplications=no
RestartApplications=no
SetupLogging=yes

[Files]
Source: "{#BundleRoot}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Uninstall {#ProductName}"; Filename: "{uninstallexe}"

[Code]
const
  UserEnvironmentKey = 'Environment';
  JobAgentRuntimeHome = '{%USERPROFILE}\.geekgeekrun-job-agent';

function NormalizePathEntry(Value: string): string;
begin
  Result := Trim(Value);
  if (Length(Result) >= 2) and (Result[1] = '"') and (Result[Length(Result)] = '"') then
    Result := Copy(Result, 2, Length(Result) - 2);
  while (Length(Result) > 3) and (Result[Length(Result)] = '\') do
    Delete(Result, Length(Result), 1);
end;

function PathContainsEntry(PathValue, Entry: string): Boolean;
var
  Remaining: string;
  Segment: string;
  Separator: Integer;
begin
  Result := False;
  Remaining := PathValue;
  while Remaining <> '' do
  begin
    Separator := Pos(';', Remaining);
    if Separator = 0 then
    begin
      Segment := Remaining;
      Remaining := '';
    end
    else
    begin
      Segment := Copy(Remaining, 1, Separator - 1);
      Delete(Remaining, 1, Separator);
    end;
    if CompareText(NormalizePathEntry(Segment), NormalizePathEntry(Entry)) = 0 then
    begin
      Result := True;
      Exit;
    end;
  end;
end;

function RemovePathEntry(PathValue, Entry: string): string;
var
  Remaining: string;
  Segment: string;
  Separator: Integer;
begin
  Result := '';
  Remaining := PathValue;
  while Remaining <> '' do
  begin
    Separator := Pos(';', Remaining);
    if Separator = 0 then
    begin
      Segment := Remaining;
      Remaining := '';
    end
    else
    begin
      Segment := Copy(Remaining, 1, Separator - 1);
      Delete(Remaining, 1, Separator);
    end;
    Segment := Trim(Segment);
    if (Segment <> '') and
       (CompareText(NormalizePathEntry(Segment), NormalizePathEntry(Entry)) <> 0) then
    begin
      if Result <> '' then
        Result := Result + ';';
      Result := Result + Segment;
    end;
  end;
end;

procedure AddLauncherDirectoryToUserPath;
var
  CurrentPath: string;
  LauncherDirectory: string;
begin
  LauncherDirectory := ExpandConstant('{app}');
  if not RegQueryStringValue(HKCU, UserEnvironmentKey, 'Path', CurrentPath) then
    CurrentPath := '';
  if not PathContainsEntry(CurrentPath, LauncherDirectory) then
  begin
    if (CurrentPath <> '') and (CurrentPath[Length(CurrentPath)] <> ';') then
      CurrentPath := CurrentPath + ';';
    RegWriteStringValue(HKCU, UserEnvironmentKey, 'Path', CurrentPath + LauncherDirectory);
  end;
end;

procedure RemoveLauncherDirectoryFromUserPath;
var
  CurrentPath: string;
begin
  if RegQueryStringValue(HKCU, UserEnvironmentKey, 'Path', CurrentPath) then
    RegWriteStringValue(
      HKCU,
      UserEnvironmentKey,
      'Path',
      RemovePathEntry(CurrentPath, ExpandConstant('{app}'))
    );
end;

function CompleteRemovalRequested: Boolean;
var
  Index: Integer;
begin
  Result := False;
  for Index := 1 to ParamCount do
    if CompareText(ParamStr(Index), '/GGRREMOVEALL=1') = 0 then
    begin
      Result := True;
      Exit;
    end;
end;

procedure RemoveSensitiveRuntimeState;
var
  RuntimeHome: string;
begin
  RuntimeHome := ExpandConstant(JobAgentRuntimeHome);
  if CompleteRemovalRequested then
  begin
    DelTree(RuntimeHome, True, True, True);
    Exit;
  end;
  DelTree(RuntimeHome + '\browser', True, True, True);
  DelTree(RuntimeHome + '\tokens', True, True, True);
  DelTree(RuntimeHome + '\temp', True, True, True);
  DelTree(RuntimeHome + '\data', True, True, True);
end;

procedure RemoveStoredCredentials;
var
  ResultCode: Integer;
  PowerShellPath: string;
  CleanupScriptPath: string;
  Parameters: string;
begin
  PowerShellPath := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
  CleanupScriptPath := ExpandConstant('{app}\installer-support\cleanup-job-agent-credentials.ps1');
  Parameters := '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' +
    CleanupScriptPath + '" -InstallRoot "' + ExpandConstant('{app}') + '"';
  if (not Exec(PowerShellPath, Parameters, '', SW_HIDE, ewWaitUntilTerminated, ResultCode)) or
     (ResultCode <> 0) then
    RaiseException('Stored Job Agent credentials could not be removed.');
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    AddLauncherDirectoryToUserPath;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
  begin
    RemoveLauncherDirectoryFromUserPath;
    RemoveStoredCredentials;
    RemoveSensitiveRuntimeState;
  end;
end;
