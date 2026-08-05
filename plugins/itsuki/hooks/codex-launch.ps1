[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("SessionStart", "SessionEnd")]
    [string]$Hook
)

$ErrorActionPreference = "Stop"

# Do this before invoking any module-backed cmdlet. A workspace-controlled
# PSModulePath or Node preload option must never run with ITSUKI_API_KEY.
$env:PSModulePath = [IO.Path]::Combine($PSHOME, "Modules")
$PSModuleAutoLoadingPreference = "None"
foreach ($name in @(
    "NODE_OPTIONS",
    "NODE_PATH",
    "NODE_EXTRA_CA_CERTS",
    "NODE_TLS_REJECT_UNAUTHORIZED",
    "NODE_USE_ENV_PROXY",
    "NODE_DEBUG",
    "NODE_DEBUG_NATIVE",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "SSLKEYLOGFILE",
    "OPENSSL_CONF",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY"
)) {
    [Environment]::SetEnvironmentVariable($name, $null, "Process")
}

$trustedSystemDirectory = [Environment]::SystemDirectory
$trustedWindowsRoot = [IO.Directory]::GetParent($trustedSystemDirectory).FullName
$trustedSystemPowerShell = [IO.Path]::Combine($trustedSystemDirectory, "WindowsPowerShell\v1.0\powershell.exe")
$trustedPowerShellInfo = [IO.FileInfo]::new($trustedSystemPowerShell)
$trustedPowerShellInfo.Refresh()
if (-not $trustedPowerShellInfo.Exists -or (($trustedPowerShellInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
    throw "The trusted system PowerShell runtime is unavailable."
}
[Environment]::SetEnvironmentVariable("SystemRoot", $trustedWindowsRoot, "Process")
[Environment]::SetEnvironmentVariable("WINDIR", $trustedWindowsRoot, "Process")
[Environment]::SetEnvironmentVariable("ITSUKI_SYSTEM_POWERSHELL", $trustedPowerShellInfo.FullName, "Process")

$pluginRootValue = [Environment]::GetEnvironmentVariable("PLUGIN_ROOT", "Process")
if ([string]::IsNullOrWhiteSpace($pluginRootValue) -or -not [IO.Path]::IsPathRooted($pluginRootValue)) {
    throw "Codex did not provide an absolute PLUGIN_ROOT."
}
$pluginRoot = [IO.Path]::GetFullPath($pluginRootValue).TrimEnd("\", "/")
$scriptName = if ($Hook -eq "SessionStart") { "codex-session-start.mjs" } else { "codex-session-end.mjs" }
$scriptPath = [IO.Path]::GetFullPath([IO.Path]::Combine($pluginRoot, "hooks", $scriptName))
$pluginPrefix = $pluginRoot + [IO.Path]::DirectorySeparatorChar
if (-not $scriptPath.StartsWith($pluginPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "The resolved Codex hook script escaped PLUGIN_ROOT."
}
$scriptInfo = [IO.FileInfo]::new($scriptPath)
$scriptInfo.Refresh()
if (-not $scriptInfo.Exists -or (($scriptInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
    throw "The resolved Codex hook script is not a plain file."
}

# Windows executable lookup can otherwise consult the session cwd. Search
# absolute PATH entries ourselves and reject the current Git worktree so a
# repository-local node.exe cannot receive ITSUKI_API_KEY.
$workspace = [IO.Path]::GetFullPath([Environment]::CurrentDirectory).TrimEnd("\", "/")
$excludedRoot = $workspace
$cursor = [IO.DirectoryInfo]::new($workspace)
while ($null -ne $cursor) {
    $gitMarker = [IO.Path]::Combine($cursor.FullName, ".git")
    if ([IO.Directory]::Exists($gitMarker) -or [IO.File]::Exists($gitMarker)) {
        $excludedRoot = [IO.Path]::GetFullPath($cursor.FullName).TrimEnd("\", "/")
        break
    }
    $cursor = $cursor.Parent
}
$excludedPrefix = $excludedRoot + [IO.Path]::DirectorySeparatorChar

$nodePath = $null
$pathValue = [Environment]::GetEnvironmentVariable("PATH", "Process")
foreach ($entryValue in ($pathValue -split [IO.Path]::PathSeparator)) {
    $entry = $entryValue.Trim().Trim('"')
    if ([string]::IsNullOrWhiteSpace($entry) -or -not [IO.Path]::IsPathRooted($entry)) { continue }
    try {
        $candidate = [IO.Path]::GetFullPath([IO.Path]::Combine($entry, "node.exe"))
    } catch { continue }
    if ($candidate.StartsWith("\\")) { continue }
    if ($candidate.StartsWith($excludedPrefix, [StringComparison]::OrdinalIgnoreCase)) { continue }
    $candidateInfo = [IO.FileInfo]::new($candidate)
    $candidateInfo.Refresh()
    if (-not $candidateInfo.Exists) { continue }
    if (($candidateInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
    $nodePath = $candidateInfo.FullName
    break
}
if ([string]::IsNullOrWhiteSpace($nodePath)) {
    throw "No trusted absolute node.exe was found outside the active worktree."
}

$startInfo = [Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $nodePath
$startInfo.Arguments = '"' + $scriptPath + '"'
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.RedirectStandardInput = $true
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$process = [Diagnostics.Process]::new()
$process.StartInfo = $startInfo
if (-not $process.Start()) { throw "The trusted Node hook runtime did not start." }
$stdoutTask = $process.StandardOutput.ReadToEndAsync()
$stderrTask = $process.StandardError.ReadToEndAsync()
$stdinTask = [Console]::OpenStandardInput().CopyToAsync($process.StandardInput.BaseStream)
[void]$stdinTask.GetAwaiter().GetResult()
$process.StandardInput.Close()
$process.WaitForExit()
[Console]::Out.Write($stdoutTask.GetAwaiter().GetResult())
[Console]::Error.Write($stderrTask.GetAwaiter().GetResult())
exit $process.ExitCode
