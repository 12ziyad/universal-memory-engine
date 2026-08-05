param(
	[Parameter(Mandatory = $true)][string]$Path,
	[ValidateSet("EnsureDirectories", "EnsureAll")][string]$Mode = "EnsureDirectories"
)

$ErrorActionPreference = "Stop"

function New-DirectoryAcl([System.Security.Principal.SecurityIdentifier[]]$Allowed) {
	$acl = New-Object System.Security.AccessControl.DirectorySecurity
	$acl.SetAccessRuleProtection($true, $false)
	foreach ($sid in $Allowed) {
		$rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
			$sid,
			[System.Security.AccessControl.FileSystemRights]::FullControl,
			([System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit),
			[System.Security.AccessControl.PropagationFlags]::None,
			[System.Security.AccessControl.AccessControlType]::Allow
		)
		[void]$acl.AddAccessRule($rule)
	}
	return $acl
}

function New-FileAcl([System.Security.Principal.SecurityIdentifier[]]$Allowed) {
	$acl = New-Object System.Security.AccessControl.FileSecurity
	$acl.SetAccessRuleProtection($true, $false)
	foreach ($sid in $Allowed) {
		$rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
			$sid,
			[System.Security.AccessControl.FileSystemRights]::FullControl,
			[System.Security.AccessControl.AccessControlType]::Allow
		)
		[void]$acl.AddAccessRule($rule)
	}
	return $acl
}

function Assert-Acl([string]$Target, [string[]]$AllowedSids, [string]$RequiredOwner, [bool]$Directory) {
	$acl = Get-Acl -LiteralPath $Target
	if (-not $acl.AreAccessRulesProtected) { throw "ACL inheritance is still enabled" }
	$ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
	if ($ownerSid -ne $RequiredOwner) { throw "ACL owner is not the current user" }
	$seen = New-Object System.Collections.Generic.HashSet[string]
	$rules = @($acl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]))
	if ($rules.Count -ne $AllowedSids.Count) { throw "ACL rule count is not exact" }
	foreach ($rule in $rules) {
		$sid = $rule.IdentityReference.Value
		if ($rule.IsInherited) { throw "An inherited ACL entry remains" }
		if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { throw "A non-Allow ACL entry remains" }
		if ($AllowedSids -notcontains $sid) { throw "An unexpected ACL principal remains" }
		if ($rule.FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl) { throw "An ACL entry is not FullControl" }
		if ($Directory) {
			$requiredInheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
			if ($rule.InheritanceFlags -ne $requiredInheritance) { throw "A directory ACL entry has the wrong inheritance" }
		} elseif ($rule.InheritanceFlags -ne [System.Security.AccessControl.InheritanceFlags]::None) {
			throw "A file ACL entry has unexpected inheritance"
		}
		if ($rule.PropagationFlags -ne [System.Security.AccessControl.PropagationFlags]::None) { throw "An ACL entry has unexpected propagation" }
		[void]$seen.Add($sid)
	}
	foreach ($sid in $AllowedSids) {
		if (-not $seen.Contains($sid)) { throw "A required ACL principal is absent" }
	}
}

try {
	$full = [System.IO.Path]::GetFullPath($Path)
	if ($full.StartsWith("\\")) { throw "UNC outboxes are not supported" }
	if (-not (Test-Path -LiteralPath $full -PathType Container)) { throw "Outbox directory is absent" }
	if ([System.IO.Path]::GetPathRoot($full) -eq $full) { throw "A filesystem root cannot be an outbox" }
	if ((Split-Path -Leaf $full) -ne "v1" -or (Split-Path -Leaf (Split-Path -Parent $full)) -ne "outbox") {
		throw "The ACL helper only accepts an Itsuki outbox/v1 directory"
	}
	$v1 = $full
	$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
	$system = New-Object System.Security.Principal.SecurityIdentifier("S-1-5-18")
	$admins = New-Object System.Security.Principal.SecurityIdentifier("S-1-5-32-544")
	$allowed = [System.Security.Principal.SecurityIdentifier[]]@($current, $system, $admins)
	$allowedText = [string[]]@($current.Value, $system.Value, $admins.Value)

	$directoryNames = @("tmp", "staged", "groups", "pending", "inflight", "accepted", "done", "failed", "state", "locks", "control")
	$directories = @((Get-Item -LiteralPath $v1 -Force))
	foreach ($name in $directoryNames) {
		$directory = Join-Path $v1 $name
		if (-not (Test-Path -LiteralPath $directory -PathType Container)) { throw "A required outbox directory is absent" }
		$item = Get-Item -LiteralPath $directory -Force
		$directories += $item
	}
	foreach ($directory in $directories) {
		if (($directory.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Outbox contains a reparse point" }
	}
	$unexpectedDirectories = @(Get-ChildItem -LiteralPath $v1 -Force -Directory | Where-Object { $directoryNames -notcontains $_.Name } | Select-Object -First 1)
	if ($unexpectedDirectories.Count -gt 0) { throw "Outbox contains an unexpected directory" }
	foreach ($name in ($directoryNames | Where-Object { $_ -ne "locks" -and $_ -ne "done" })) {
		$nested = @(Get-ChildItem -LiteralPath (Join-Path $v1 $name) -Force -Directory | Select-Object -First 1)
		if ($nested.Count -gt 0) { throw "An active outbox directory contains a nested directory" }
	}
	$lockRoot = Join-Path $v1 "locks"
	$lockDirectories = @(Get-ChildItem -LiteralPath $lockRoot -Force -Directory | Select-Object -First 9)
	if ($lockDirectories.Count -gt 8) { throw "Outbox lock directory count exceeds the verification bound" }
	foreach ($lockDirectory in $lockDirectories) {
		if ($lockDirectory.Name -notmatch '^[a-z-]+\.lock$') { throw "Outbox contains an unexpected lock directory" }
		if (($lockDirectory.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Outbox contains a reparse point" }
		if (@(Get-ChildItem -LiteralPath $lockDirectory.FullName -Force -Directory).Count -gt 0) { throw "An outbox lock contains a nested directory" }
	}
	$directories += $lockDirectories
	$items = @($directories)
	$activeFiles = @()
	if ($Mode -eq "EnsureAll") {
		# Accepted completion tombstones contain no transcript body and may grow
		# throughout the seven-day retention window. Verify only active/sensitive
		# files here so SessionStart cannot acquire an unbounded recursive walk.
		$activeNames = @("tmp", "staged", "pending", "inflight", "accepted", "failed", "state", "control")
		foreach ($name in $activeNames) {
			$active = Join-Path $v1 $name
			if (Test-Path -LiteralPath $active -PathType Container) {
				$remaining = 1025 - $activeFiles.Count
				if ($remaining -gt 0) { $activeFiles += @(Get-ChildItem -LiteralPath $active -Force -File | Select-Object -First $remaining) }
			}
			if ($activeFiles.Count -gt 1024) { break }
		}
		if ($activeFiles.Count -le 1024) {
			foreach ($lockDirectory in $lockDirectories) {
				$remaining = 1025 - $activeFiles.Count
				if ($remaining -gt 0) { $activeFiles += @(Get-ChildItem -LiteralPath $lockDirectory.FullName -Force -File | Select-Object -First $remaining) }
				if ($activeFiles.Count -gt 1024) { break }
			}
		}
		if ($activeFiles.Count -gt 1024) { throw "Active outbox file count exceeds the verification bound" }
		$items += $activeFiles
	}
	# All shape and bound checks finish before the first ACL mutation. Only the
	# dedicated v1 root and its known children are ever touched.
	foreach ($item in $items) {
		if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Outbox contains a reparse point" }
		if ($item.PSIsContainer) {
			try { Assert-Acl $item.FullName $allowedText $current.Value $true }
			catch { Set-Acl -LiteralPath $item.FullName -AclObject (New-DirectoryAcl $allowed) }
		} elseif ($Mode -eq "EnsureAll") {
			try { Assert-Acl $item.FullName $allowedText $current.Value $false }
			catch { Set-Acl -LiteralPath $item.FullName -AclObject (New-FileAcl $allowed) }
		}
	}

	foreach ($item in $items) { Assert-Acl $item.FullName $allowedText $current.Value $item.PSIsContainer }
	@{ ok = $true; protected = $true; principals = 3; directories = $directories.Count; files = $activeFiles.Count } | ConvertTo-Json -Compress
	exit 0
} catch {
	[Console]::Error.WriteLine("Itsuki outbox ACL verification failed.")
	exit 1
}
