param(
	[Parameter(Mandatory = $true)][string]$Path,
	[ValidateSet("EnsureDirectories", "EnsureAll")][string]$Mode = "EnsureDirectories"
)

$ErrorActionPreference = "Stop"

function New-PrivateDirectoryAcl([System.Security.Principal.SecurityIdentifier[]]$Allowed) {
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

function New-PrivateFileAcl([System.Security.Principal.SecurityIdentifier[]]$Allowed) {
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

function Assert-PrivateAcl([string]$Target, [string[]]$Allowed, [string]$RequiredOwner, [bool]$Directory) {
	$acl = Get-Acl -LiteralPath $Target
	if (-not $acl.AreAccessRulesProtected) { throw "ACL inheritance remains enabled" }
	$owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
	if ($owner -ne $RequiredOwner) { throw "ACL owner is not the current user" }
	$rules = @($acl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]))
	if ($rules.Count -ne $Allowed.Count) { throw "ACL rule count is not exact" }
	foreach ($rule in $rules) {
		if ($rule.IsInherited) { throw "An inherited ACL entry remains" }
		if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { throw "A deny ACL entry remains" }
		if ($Allowed -notcontains $rule.IdentityReference.Value) { throw "An unexpected ACL principal remains" }
		if ($rule.FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl) { throw "An ACL entry is not FullControl" }
		if ($Directory) {
			$inherit = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
			if ($rule.InheritanceFlags -ne $inherit) { throw "A directory ACL has the wrong inheritance" }
		} elseif ($rule.InheritanceFlags -ne [System.Security.AccessControl.InheritanceFlags]::None) {
			throw "A file ACL has unexpected inheritance"
		}
	}
}

try {
	$full = [System.IO.Path]::GetFullPath($Path)
	if ($full.StartsWith("\\")) { throw "UNC queues are not supported" }
	if ([System.IO.Path]::GetPathRoot($full) -eq $full) { throw "A filesystem root cannot be a queue" }
	if ((Split-Path -Leaf $full) -ne "v1" -or (Split-Path -Leaf (Split-Path -Parent $full)) -ne "codex-outbox") {
		throw "The ACL helper only accepts a codex-outbox/v1 directory"
	}
	$names = @("tmp", "staged", "failed", "state", "locks", "control")
	$directories = @((Get-Item -LiteralPath $full -Force))
	foreach ($name in $names) {
		$child = Join-Path $full $name
		if (-not (Test-Path -LiteralPath $child -PathType Container)) { throw "A required queue directory is absent" }
		$directories += Get-Item -LiteralPath $child -Force
	}
	$unexpected = @(Get-ChildItem -LiteralPath $full -Force | Where-Object { $names -notcontains $_.Name } | Select-Object -First 1)
	if ($unexpected.Count -gt 0) { throw "The queue root contains an unexpected entry" }
	foreach ($directory in $directories) {
		if (($directory.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "The queue contains a reparse point" }
	}
	$staged = @(Get-ChildItem -LiteralPath (Join-Path $full "staged") -Force)
	if ($staged.Count -gt 65) { throw "The queue exceeds its file bound" }
	foreach ($item in $staged) {
		if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.Name -notmatch '^codex_[a-f0-9]{64}\.json$') {
			throw "The staged queue contains an unexpected entry"
		}
	}
	$tmp = @(Get-ChildItem -LiteralPath (Join-Path $full "tmp") -Force)
	if ($tmp.Count -gt 8) { throw "The queue exceeds its temporary-file bound" }
	foreach ($item in $tmp) {
		if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.Name -notmatch '^\.(codex|recall-guard|stale-lock)-[a-f0-9-]{36}\.tmp$' -or $item.Length -gt 524288) {
			throw "The temporary queue contains an unexpected entry"
		}
	}
	$failed = @(Get-ChildItem -LiteralPath (Join-Path $full "failed") -Force)
	if ($failed.Count -gt 65) { throw "The queue exceeds its quarantine bound" }
	foreach ($item in $failed) {
		if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.Name -notmatch '^codex_[a-f0-9]{64}\.json$') {
			throw "The quarantine directory contains an unexpected entry"
		}
	}
	$state = @(Get-ChildItem -LiteralPath (Join-Path $full "state") -Force)
	if ($state.Count -gt 130) { throw "The queue exceeds its state bound" }
	foreach ($item in $state) {
		if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.Name -notmatch '^codex_[a-f0-9]{64}\.json$' -or $item.Length -gt 4096) {
			throw "The state directory contains an unexpected entry"
		}
	}
	$locks = @(Get-ChildItem -LiteralPath (Join-Path $full "locks") -Force)
	if ($locks.Count -gt 3) { throw "The queue exceeds its lock bound" }
	foreach ($item in $locks) {
		if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.Name -notmatch '^[a-z-]+\.lock$') {
			throw "The lock directory contains an unexpected entry"
		}
	}
	$control = @(Get-ChildItem -LiteralPath (Join-Path $full "control") -Force)
	if ($control.Count -gt 1) { throw "The queue exceeds its control-file bound" }
	foreach ($item in $control) {
		if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.Name -ne "recall-guard.json") {
			throw "The control directory contains an unexpected entry"
		}
	}

	$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
	$system = New-Object System.Security.Principal.SecurityIdentifier("S-1-5-18")
	$admins = New-Object System.Security.Principal.SecurityIdentifier("S-1-5-32-544")
	$allowed = [System.Security.Principal.SecurityIdentifier[]]@($current, $system, $admins)
	$allowedText = [string[]]@($current.Value, $system.Value, $admins.Value)
	foreach ($directory in $directories) {
		try { Assert-PrivateAcl $directory.FullName $allowedText $current.Value $true }
		catch { Set-Acl -LiteralPath $directory.FullName -AclObject (New-PrivateDirectoryAcl $allowed) }
		Assert-PrivateAcl $directory.FullName $allowedText $current.Value $true
	}
	if ($Mode -eq "EnsureAll") {
		foreach ($item in @($staged + $failed + $state + $locks + $control + $tmp)) {
			# Another hook may complete an atomic rename, release a lock, or
			# remove an accepted staged envelope after enumeration. Only skip a
			# path that is actually gone; every surviving file is still repaired
			# and verified against the exact allowlist.
			if (-not [System.IO.File]::Exists($item.FullName)) { continue }
			try { Assert-PrivateAcl $item.FullName $allowedText $current.Value $false }
			catch {
				if (-not [System.IO.File]::Exists($item.FullName)) { continue }
				try { Set-Acl -LiteralPath $item.FullName -AclObject (New-PrivateFileAcl $allowed) }
				catch {
					if (-not [System.IO.File]::Exists($item.FullName)) { continue }
					throw
				}
			}
			if (-not [System.IO.File]::Exists($item.FullName)) { continue }
			try { Assert-PrivateAcl $item.FullName $allowedText $current.Value $false }
			catch {
				if (-not [System.IO.File]::Exists($item.FullName)) { continue }
				throw
			}
		}
	}
	@{ ok = $true; protected = $true; directories = $directories.Count; files = $staged.Count } | ConvertTo-Json -Compress
	exit 0
} catch {
	[Console]::Error.WriteLine("Itsuki Codex queue ACL verification failed.")
	exit 1
}
