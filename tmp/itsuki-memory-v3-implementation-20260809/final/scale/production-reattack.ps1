$ErrorActionPreference = "Stop"

if (-not $env:ITSUKI_API_KEY) {
    Write-Output "ITSUKI_API_KEY=MISSING"
    exit 2
}
Write-Output "ITSUKI_API_KEY=LOADED"

$frozenPath = Join-Path $PSScriptRoot "..\..\phase3-d04\evidence\d04.conv-26.t4.questions.jsonl"
$frozen = Get-Content -LiteralPath $frozenPath -TotalCount 1 | ConvertFrom-Json
if (-not $frozen.question -or $frozen.sampleId -ne "conv-26") {
    throw "frozen product-input question unavailable"
}

$payload = @{
    userId = "locomo-d04-conv-26"
    query = $frozen.question
    limit = 200
} | ConvertTo-Json -Compress

$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$configPath = [IO.Path]::Combine($tempRoot, "itsuki-d13-$([Guid]::NewGuid().ToString('N')).cfg")
$payloadPath = [IO.Path]::Combine($tempRoot, "itsuki-d13-$([Guid]::NewGuid().ToString('N')).json")
if (-not ([IO.Path]::GetFullPath($configPath).StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) `
    -or -not ([IO.Path]::GetFullPath($payloadPath).StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase))) {
    throw "temporary credential path escaped the OS temp directory"
}

$started = Get-Date
$removed = $false
try {
    [IO.File]::WriteAllText($configPath, "header = `"Authorization: Bearer $($env:ITSUKI_API_KEY)`"`n")
    [IO.File]::WriteAllText($payloadPath, $payload)
    $output = & curl.exe --config $configPath --silent --show-error --connect-timeout 10 --max-time 45 `
        --request POST --header "Content-Type: application/json" --data-binary "@$payloadPath" `
        --write-out "`n%{http_code}" "https://itsuki.app/v1/recall"
    $curlCode = $LASTEXITCODE
} finally {
    if (Test-Path -LiteralPath $configPath) {
        Remove-Item -LiteralPath $configPath -Force
    }
    if (Test-Path -LiteralPath $payloadPath) {
        Remove-Item -LiteralPath $payloadPath -Force
    }
    $removed = -not (Test-Path -LiteralPath $configPath) -and -not (Test-Path -LiteralPath $payloadPath)
}

if ($curlCode -ne 0) {
    [pscustomobject]@{
        schema = "itsuki.v3-d13-production-reattack/v1"
        pass = $false
        classification = "transport_or_product_timeout"
        curlExit = $curlCode
        clientElapsedMs = [math]::Round(((Get-Date) - $started).TotalMilliseconds)
        temporaryFilesRemoved = $removed
    } | ConvertTo-Json -Compress
    exit 1
}

$status = [int]$output[-1]
$raw = ($output[0..($output.Count - 2)] -join "`n")
$body = $raw | ConvertFrom-Json
$lanes = $body.bounded_recall_lane_counts
$corpus = $body.bounded_recall_corpus_counts
$laneValues = @($lanes.PSObject.Properties.Value | ForEach-Object { [int]$_ })
$laneBound = $laneValues.Count -gt 0 -and @($laneValues | Where-Object { $_ -gt 200 }).Count -eq 0
$contextChars = ([string]$body.context).Length
$corpusBound = [int]$corpus.nodes -le 600 `
    -and [int]$corpus.pages -le 200 `
    -and [int]$corpus.slices -le 2400 `
    -and [int]$corpus.events -le 4000 `
    -and [int]$corpus.edges -le 600
$pass = $status -eq 200 `
    -and $body.bounded_recall_corpus_used -eq $true `
    -and [int]$body.bounded_recall_failures -eq 0 `
    -and $laneBound `
    -and $corpusBound `
    -and @($body.items).Count -le 200 `
    -and $contextChars -le 24000 `
    -and $removed

[pscustomobject]@{
    schema = "itsuki.v3-d13-production-reattack/v1"
    pass = $pass
    status = $status
    boundedCorpusUsed = $body.bounded_recall_corpus_used
    boundedFailures = $body.bounded_recall_failures
    laneBound = $laneBound
    corpusBound = $corpusBound
    laneCounts = $lanes
    corpusCounts = $corpus
    itemCount = @($body.items).Count
    contextChars = $contextChars
    recallLatencyMs = $body.recall_latency_ms
    clientElapsedMs = [math]::Round(((Get-Date) - $started).TotalMilliseconds)
    sourceExpansionUsed = $body.source_expansion_used -eq $true
    temporaryFilesRemoved = $removed
} | ConvertTo-Json -Depth 5 -Compress

if (-not $pass) { exit 1 }
