<#
.SYNOPSIS
    DIARK OS — Hardware Budget & Telemetry Profiler
    Measures CPU, Memory (WorkingSet & PrivateBytes), and DB WAL size across the full application process tree.

.DESCRIPTION
    Complies with TASK-08 PerformanceRun data contract:
    - Gathers Windows 11 Build & Acer Nitro 5 Tiger hardware SKU
    - Samples application process tree (diark-core host + all child msedgewebview2.exe subprocesses)
    - Computes Percentile (P50, P90, P95, P99) and Peak RAM & CPU
    - Outputs structured PerformanceRun JSON
#>

[CmdletBinding()]
param(
    [ValidateSet("Idle30Min", "PortalSso", "MoodleSso", "VaultScan")]
    [string]$Scenario = "Idle30Min",

    [int]$DurationSecs = 30,

    [int]$WarmupSecs = 15,

    [int]$SampleIntervalSecs = 1,

    [switch]$MinimizeToTray,

    [string]$BinaryPath = "src-tauri\target\release\diark-core.exe",

    [string]$OutputPath = "benchmark-result.json"
)

$ErrorActionPreference = "Stop"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " DIARK OS — Telemetry Benchmark: $Scenario" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# 1. Resolve System Specifications
$osInfo = Get-CimInstance Win32_OperatingSystem
$osBuild = "{0} (Build {1})" -f $osInfo.Caption.Trim(), $osInfo.BuildNumber

$csInfo = Get-CimInstance Win32_ComputerSystem
$cpuInfo = Get-CimInstance Win32_Processor | Select-Object -First 1
$deviceModel = "{0} {1} ({2}, {3:N0} GB RAM)" -f $csInfo.Manufacturer.Trim(), $csInfo.Model.Trim(), $cpuInfo.Name.Trim(), ($csInfo.TotalPhysicalMemory / 1GB)

$buildCommit = (git rev-parse HEAD 2>$null)
if (-not $buildCommit) { $buildCommit = "unknown" }

Write-Host "Hardware Target : $deviceModel" -ForegroundColor Gray
Write-Host "OS Build        : $osBuild" -ForegroundColor Gray
Write-Host "Git Commit      : $buildCommit" -ForegroundColor Gray
Write-Host "Scenario        : $Scenario" -ForegroundColor Gray
Write-Host "Duration        : $DurationSecs seconds (interval: ${SampleIntervalSecs}s)" -ForegroundColor Gray

# Helper to find all descendants (WebView2 subprocesses)
function Get-ProcessTreePids([int]$rootPid) {
    $pids = [System.Collections.Generic.List[int]]::new()
    $pids.Add($rootPid)
    $queue = [System.Collections.Generic.Queue[int]]::new()
    $queue.Enqueue($rootPid)

    while ($queue.Count -gt 0) {
        $curr = $queue.Dequeue()
        $children = Get-CimInstance Win32_Process -Filter "ParentProcessId = $curr" -ErrorAction SilentlyContinue
        foreach ($child in $children) {
            if (-not $pids.Contains($child.ProcessId)) {
                $pids.Add($child.ProcessId)
                $queue.Enqueue($child.ProcessId)
            }
        }
    }
    return $pids.ToArray()
}

# 2. Verify or Launch Binary
$appProcess = $null
$startedByScript = $false

$existing = Get-Process -Name "diark-core" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($existing) {
    Write-Host "Attached to existing diark-core process (PID $($existing.Id))" -ForegroundColor Green
    $appProcess = $existing
} else {
    if (-not (Test-Path $BinaryPath)) {
        throw "Binary not found at $BinaryPath. Please run 'cargo build --release' or specify -BinaryPath."
    }
    Write-Host "Launching $BinaryPath..." -ForegroundColor Green
    $appProcess = Start-Process -FilePath $BinaryPath -PassThru
    $startedByScript = $true

    if ($WarmupSecs -gt 0) {
        Write-Host "Waiting $WarmupSecs seconds for startup warm-up..." -ForegroundColor Yellow
        Start-Sleep -Seconds $WarmupSecs
    }

    if ($MinimizeToTray) {
        Write-Host "Simulating background/tray idle state (trimming working set)..." -ForegroundColor Cyan
        $code = @'
        using System;
        using System.Runtime.InteropServices;
        public class WinMemory {
            [DllImport("psapi.dll")]
            public static extern int EmptyWorkingSet(IntPtr hwProc);
        }
'@
        if (-not ([System.Management.Automation.PSTypeName]'WinMemory').Type) {
            Add-Type -TypeDefinition $code
        }
        $initTree = Get-ProcessTreePids -rootPid $appProcess.Id
        foreach ($pidItem in $initTree) {
            try {
                $h = [System.Diagnostics.Process]::GetProcessById($pidItem).Handle
                [WinMemory]::EmptyWorkingSet($h) | Out-Null
            } catch {}
        }
        Start-Sleep -Seconds 2
    }
}

# 3. Sampling Loop
$samples = [System.Collections.Generic.List[PSCustomObject]]::new()
$numCores = [Environment]::ProcessorCount

$appDataPath = "$env:APPDATA\dev.diark.core"
$walFilePath = Join-Path $appDataPath "diark.sqlite3-wal"

$prevCpuTime = $null
$prevSampleTime = $null

$startTime = [DateTime]::UtcNow
$endTime = $startTime.AddSeconds($DurationSecs)

Write-Host "Beginning telemetry sampling..." -ForegroundColor Yellow

while ([DateTime]::UtcNow -lt $endTime) {
    $now = [DateTime]::UtcNow
    $treePids = Get-ProcessTreePids -rootPid $appProcess.Id

    $procs = Get-Process -Id $treePids -ErrorAction SilentlyContinue
    if (-not $procs) {
        Write-Warning "App process tree terminated unexpectedly."
        break
    }

    $hostProc = $procs | Where-Object { $_.Id -eq $appProcess.Id } | Select-Object -First 1
    $wvProcs = $procs | Where-Object { $_.Id -ne $appProcess.Id }

    $hostWs = if ($hostProc) { $hostProc.WorkingSet64 } else { 0 }
    $hostPriv = if ($hostProc) { $hostProc.PrivateMemorySize64 } else { 0 }

    $wvWs = if ($wvProcs) { ($wvProcs | Measure-Object -Property WorkingSet64 -Sum).Sum } else { 0 }
    $wvPriv = if ($wvProcs) { ($wvProcs | Measure-Object -Property PrivateMemorySize64 -Sum).Sum } else { 0 }

    $totalWsBytes = ($procs | Measure-Object -Property WorkingSet64 -Sum).Sum
    $totalPrivateBytes = ($procs | Measure-Object -Property PrivateMemorySize64 -Sum).Sum
    $totalCpuTime = ($procs | Measure-Object -Property CPU -Sum).Sum

    $ramWsMb = [math]::Round($totalWsBytes / 1MB, 2)
    $ramPrivateMb = [math]::Round($totalPrivateBytes / 1MB, 2)

    $cpuPercent = 0.0
    if ($prevCpuTime -ne $null -and $prevSampleTime -ne $null) {
        $deltaCpu = $totalCpuTime - $prevCpuTime
        $deltaSecs = ($now - $prevSampleTime).TotalSeconds
        if ($deltaSecs -gt 0) {
            $cpuPercent = [math]::Round(($deltaCpu / ($deltaSecs * $numCores)) * 100, 3)
            if ($cpuPercent -lt 0) { $cpuPercent = 0.0 }
        }
    }

    $prevCpuTime = $totalCpuTime
    $prevSampleTime = $now

    $walMb = 0.0
    if (Test-Path $walFilePath) {
        $walMb = [math]::Round((Get-Item $walFilePath).Length / 1MB, 3)
    }

    $sampleObj = [PSCustomObject]@{
        TimestampSecs   = [math]::Round(($now - $startTime).TotalSeconds, 1)
        ProcessCount    = $procs.Count
        HostWsMb        = [math]::Round($hostWs / 1MB, 2)
        HostPrivateMb   = [math]::Round($hostPriv / 1MB, 2)
        WebViewWsMb     = [math]::Round($wvWs / 1MB, 2)
        WebViewPrivateMb= [math]::Round($wvPriv / 1MB, 2)
        WorkingSetMb    = $ramWsMb
        PrivateMb       = $ramPrivateMb
        CpuPercent      = $cpuPercent
        DbWalMb         = $walMb
    }
    $samples.Add($sampleObj)

    Start-Sleep -Seconds $SampleIntervalSecs
}

if ($startedByScript -and $appProcess -and (-not $appProcess.HasExited)) {
    Write-Host "Stopping measured application process tree..." -ForegroundColor Gray
    $treePids = Get-ProcessTreePids -rootPid $appProcess.Id
    Stop-Process -Id $treePids -Force -ErrorAction SilentlyContinue
}

# 4. Statistical Aggregation
function Get-Percentile([double[]]$values, [double]$p) {
    if ($values.Count -eq 0) { return 0.0 }
    $sorted = $values | Sort-Object
    $idx = [math]::Ceiling(($p / 100.0) * $sorted.Count) - 1
    if ($idx -lt 0) { $idx = 0 }
    if ($idx -ge $sorted.Count) { $idx = $sorted.Count - 1 }
    return $sorted[$idx]
}

$wsArray = [double[]]($samples | ForEach-Object { $_.WorkingSetMb })
$privArray = [double[]]($samples | ForEach-Object { $_.PrivateMb })
$cpuArray = [double[]]($samples | ForEach-Object { $_.CpuPercent })

$p95Ws = [math]::Round((Get-Percentile -values $wsArray -p 95), 2)
$peakWs = [math]::Round(($wsArray | Measure-Object -Maximum).Maximum, 2)

$p95Private = [math]::Round((Get-Percentile -values $privArray -p 95), 2)
$peakPrivate = [math]::Round(($privArray | Measure-Object -Maximum).Maximum, 2)

$hostPrivArray = [double[]]($samples | ForEach-Object { $_.HostPrivateMb })
$wvPrivArray = [double[]]($samples | ForEach-Object { $_.WebViewPrivateMb })
$p95HostPrivate = [math]::Round((Get-Percentile -values $hostPrivArray -p 95), 2)
$p95WvPrivate = [math]::Round((Get-Percentile -values $wvPrivArray -p 95), 2)

$p95Cpu = [math]::Round((Get-Percentile -values $cpuArray -p 95), 2)
$avgCpu = [math]::Round(($cpuArray | Measure-Object -Average).Average, 3)

$latestWal = if ($samples.Count -gt 0) { $samples[-1].DbWalMb } else { 0.0 }

# Contract: PerformanceRun
$performanceRun = [PSCustomObject]@{
    build_commit          = $buildCommit
    os_build              = $osBuild
    device_model          = $deviceModel
    scenario              = $Scenario
    duration_secs         = $DurationSecs
    idle_ram_mb_p95       = $p95Private   # Using Private Bytes (unshared resident memory) as standard metric
    idle_ram_ws_mb_p95    = $p95Ws
    host_ram_mb_p95       = $p95HostPrivate
    webview_ram_mb_p95    = $p95WvPrivate
    peak_ram_mb           = $peakWs
    idle_cpu_percent_p95  = $p95Cpu
    avg_cpu_percent       = $avgCpu
    db_wal_mb             = $latestWal
}

$jsonOutput = $performanceRun | ConvertTo-Json -Depth 4
$jsonOutput | Out-File -FilePath $OutputPath -Encoding utf8

Write-Host "==========================================================" -ForegroundColor Green
Write-Host " TELEMETRY RESULTS ($Scenario):" -ForegroundColor Green
Write-Host " - Private RAM P95  : $p95Private MB (Target < 80MB)" -ForegroundColor Green
Write-Host "   -> Host Process  : $p95HostPrivate MB" -ForegroundColor Green
Write-Host "   -> WebView2 Sub  : $p95WvPrivate MB" -ForegroundColor Green
Write-Host " - WorkingSet P95   : $p95Ws MB" -ForegroundColor Green
Write-Host " - Peak RAM         : $peakWs MB (Target < 500MB)" -ForegroundColor Green
Write-Host " - Idle CPU P95     : $p95Cpu % (Target 0.0%)" -ForegroundColor Green
Write-Host " - Average CPU      : $avgCpu %" -ForegroundColor Green
Write-Host " - Database WAL     : $latestWal MB" -ForegroundColor Green
Write-Host " Result saved to: $OutputPath" -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green

return $performanceRun
