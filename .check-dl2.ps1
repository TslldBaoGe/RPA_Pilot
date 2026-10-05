$ErrorActionPreference = 'Continue'
$cache = "$env:LOCALAPPDATA\rpa-pilot-updater"

Write-Output "=== 1) client process running? ==="
$procs = Get-Process -Name 'RPA_Pilot' -ErrorAction SilentlyContinue
if ($procs) { Write-Output ("  yes, {0} processes" -f $procs.Count) }
else { Write-Output "  NO - client is not running (download cannot progress)" }

Write-Output ""
Write-Output "=== 2) active connection to update server? ==="
$conns = Get-NetTCPConnection -RemoteAddress '43.173.66.157' -ErrorAction SilentlyContinue |
    Where-Object { $_.State -eq 'Established' }
if ($conns) { $conns | ForEach-Object { Write-Output ("  Established port {0} PID {1}" -f $_.RemotePort, $_.OwningProcess) } }
else { Write-Output "  none" }

Write-Output ""
Write-Output "=== 3) leftover partial downloads in cache ==="
$tmps = Get-ChildItem $cache -Recurse -Force -Filter 'temp-*' -ErrorAction SilentlyContinue
$totalStale = 0L
foreach ($f in $tmps) {
    Write-Output ("  {0,-40} {1,7:N2} MB  {2}" -f $f.Name, ($f.Length/1MB), $f.LastWriteTime.ToString('HH:mm:ss'))
    $totalStale += $f.Length
}
Write-Output ("  total wasted: {0:N2} MB" -f ($totalStale/1MB))

Write-Output ""
Write-Output "=== 4) does the newest temp file still grow? (30s sample) ==="
$newest = $tmps | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($newest) {
    $s1 = [long]$newest.Length
    Start-Sleep -Seconds 30
    $s2 = [long](Get-Item $newest.FullName).Length
    Write-Output ("  {0}: {1:N2} MB -> {2:N2} MB" -f $newest.Name, ($s1/1MB), ($s2/1MB))
    Write-Output ("  rate: {0:N1} KB/s" -f (($s2-$s1)/30/1KB))
} else { Write-Output "  none" }

Write-Output ""
Write-Output "=== 5) what the server actually HAS + how fast it serves it ==="
$yml = curl.exe -sS --connect-timeout 10 --max-time 20 'http://43.173.66.157:8088/latest.yml' 2>&1
$ver = ''
$pkg = ''
foreach ($line in $yml) {
    if ("$line" -match '^version:\s*(\S+)') { $ver = $Matches[1] }
    if ("$line" -match '^\s*-?\s*url:\s*(\S+)') { if (-not $pkg) { $pkg = $Matches[1] } }
}
Write-Output ("  server latest.yml version = {0}" -f $ver)
Write-Output ("  package = {0}" -f $pkg)

if ($pkg) {
    $url = "http://43.173.66.157:8088/$pkg"
    $o = curl.exe -sS -o NUL --max-time 15 --connect-timeout 10 -w '%{size_download}|%{http_code}' $url 2>&1
    $bytes = 0L; $code = '?'
    foreach ($x in $o) {
        if ("$x".Trim() -match '^(\d+)\|(\d+)$') { $bytes = [long]$Matches[1]; $code = $Matches[2] }
    }
    Write-Output ("  HTTP {0}, got {1:N0} KB in 15s = {2:N1} KB/s" -f $code, ($bytes/1KB), ($bytes/15/1KB))
    if ($bytes -gt 0) {
        Write-Output ("  => 115 MB would take {0:N1} min at this speed" -f (115.38MB/($bytes/15)/60))
    }
}

Write-Output ""
Write-Output "=== 6) update.log tail ==="
$ul = "$env:APPDATA\rpa-pilot\update.log"
if (Test-Path $ul) {
    Get-Content $ul -Tail 12 | ForEach-Object {
        $t = ''
        if ($_ -match '^(\S+Z)\s(.*)$') {
            try { $t = ([datetime]$Matches[1]).ToLocalTime().ToString('HH:mm:ss') } catch { $t = '' }
            Write-Output ("  [{0}] {1}" -f $t, $Matches[2])
        } else { Write-Output ("  {0}" -f $_) }
    }
} else { Write-Output "  no update.log" }
