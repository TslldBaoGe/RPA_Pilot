<#
.SYNOPSIS
    从 GitHub Release 拉取最新安装包，放进内网 Web 服务器的更新目录。

.DESCRIPTION
    同事的客户端定期向这个更新目录请求 latest.yml。本脚本负责把 GitHub 上
    最新 Release 的产物同步过来，让「发版」和「客户端更新」之间只差一个计划任务。

    之所以由服务器主动「拉」而不是让 GitHub「推」：
    拉取只需要出站 HTTPS，不需要在内网开任何入站端口，防火墙那边什么都不用改。

.EXAMPLE
    .\sync-updates.ps1 -Repo yourname/rpa-pilot -TargetDir D:\inetpub\wwwroot\rpa-pilot

.EXAMPLE
    # 只看现在 GitHub 上是哪个版本，不下载
    .\sync-updates.ps1 -Repo yourname/rpa-pilot -TargetDir D:\inetpub\wwwroot\rpa-pilot -CheckOnly

.NOTES
    只读公有仓库不需要任何凭证。
    如果以后改成私有仓库，设环境变量 RPA_PILOT_GITHUB_TOKEN（或传 -Token）。
#>
[CmdletBinding()]
param(
    # GitHub 仓库，形如 owner/repo
    [Parameter(Mandatory = $true)]
    [string]$Repo,

    # 更新目录（IIS / Nginx 指向的那个目录）
    [Parameter(Mandatory = $true)]
    [string]$TargetDir,

    # 保留最近几个版本，更老的安装包会被删除（回滚时用得上，别设成 1）
    [int]$Keep = 3,

    # 只查版本，不下载
    [switch]$CheckOnly,

    # 即使版本号相同也重新下载（用于修复损坏的产物）
    [switch]$Force,

    # 私有仓库用的令牌；默认取环境变量
    [string]$Token = $env:RPA_PILOT_GITHUB_TOKEN,

    # 可指向 GitHub Enterprise；也便于本地自测
    [string]$ApiBase = 'https://api.github.com',

    # 日志文件位置
    [string]$LogFile = (Join-Path $env:LOCALAPPDATA 'RPA-Pilot-UpdateSync\sync-updates.log')
)

$ErrorActionPreference = 'Stop'

# Windows PowerShell 5.1 默认可能还是 TLS 1.0，连 GitHub 会直接失败
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
} catch {
    # PowerShell 7 上不需要也不支持这样设置，忽略
}

function Write-Log {
    param([string]$Message, [string]$Level = 'INFO')
    $line = '{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    Write-Host $line
    try {
        $dir = Split-Path -Parent $LogFile
        if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        Add-Content -Path $LogFile -Value $line -Encoding UTF8
    } catch {
        # 日志写不进去不能影响同步本身
    }
}

function Send-Request {
    param([string]$Uri, [string]$OutFile)

    $headers = @{
        'User-Agent' = 'RPA-Pilot-UpdateSync'
        'Accept'     = 'application/vnd.github+json'
    }
    if ($Token) { $headers['Authorization'] = "Bearer $Token" }

    if ($OutFile) {
        # 先下到临时文件，成功后再改名 —— 避免半截文件被当成完整产物对外提供
        $temp = "$OutFile.downloading"
        Invoke-WebRequest -Uri $Uri -Headers $headers -OutFile $temp -UseBasicParsing
        Move-Item -LiteralPath $temp -Destination $OutFile -Force
    } else {
        return Invoke-RestMethod -Uri $Uri -Headers $headers
    }
}

function Get-PublishedVersion {
    param([string]$Directory)
    $yml = Join-Path $Directory 'latest.yml'
    if (-not (Test-Path $yml)) { return $null }
    try {
        $match = Select-String -Path $yml -Pattern '^\s*version:\s*(.+?)\s*$' -ErrorAction Stop |
            Select-Object -First 1
        if ($match) { return $match.Matches[0].Groups[1].Value.Trim() }
    } catch {
        return $null
    }
    return $null
}

try {
    Write-Log "开始同步：仓库 $Repo，目标目录 $TargetDir"

    if (-not (Test-Path $TargetDir)) {
        New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
        Write-Log "目标目录不存在，已创建：$TargetDir"
    }

    # ── 1) 查最新 Release ────────────────────────────
    $release = Send-Request -Uri "$ApiBase/repos/$Repo/releases/latest"
    if (-not $release -or -not $release.tag_name) {
        throw "没能从 $ApiBase/repos/$Repo/releases/latest 读到 release 信息"
    }

    $version = $release.tag_name.TrimStart('v')
    Write-Log "GitHub 上最新版本：$version（标签 $($release.tag_name)）"

    $published = Get-PublishedVersion -Directory $TargetDir
    if ($published) {
        Write-Log "本地更新目录当前版本：$published"
    } else {
        Write-Log '本地更新目录还没有 latest.yml，本次是首次同步'
    }

    if ($published -eq $version -and -not $Force) {
        Write-Log "版本一致，无需更新（要强制重下加 -Force）"
        exit 0
    }

    if ($CheckOnly) {
        Write-Log "检查模式：本次应同步 $published -> $version" 'CHECK'
        exit 0
    }

    # ── 2) 挑出需要的三个文件 ────────────────────────
    #    latest.yml              更新入口
    #    *.exe                   安装包本体
    #    *.blockmap              差量下载索引
    $wanted = @()
    foreach ($asset in $release.assets) {
        $name = $asset.name
        if ($name -eq 'latest.yml' -or $name -like '*.exe' -or $name -like '*.blockmap') {
            $wanted += $asset
        }
    }

    if ($wanted.Count -lt 2) {
        throw "Release $version 里的产物不全（只找到 $($wanted.Count) 个），需要 latest.yml + 安装包 + blockmap"
    }

    $exeAssets = @($wanted | Where-Object { $_.name -like '*.exe' })
    if ($exeAssets.Count -eq 0) { throw "Release $version 里没有 .exe 安装包" }

    # ── 3) 下载 ──────────────────────────────────────
    #    顺序很重要：latest.yml 必须最后落地。
    #    客户端是拿 latest.yml 当入口的，如果它先指向一个还没下完的安装包，
    #    这个窗口期内去检查更新的客户端就会下载失败。
    $ordered = @()
    $ordered += $wanted | Where-Object { $_.name -like '*.blockmap' }
    $ordered += $wanted | Where-Object { $_.name -like '*.exe' }
    $ordered += $wanted | Where-Object { $_.name -eq 'latest.yml' }

    foreach ($asset in $ordered) {
        $dest = Join-Path $TargetDir $asset.name
        $sizeMb = [math]::Round($asset.size / 1MB, 1)
        Write-Log "下载 $($asset.name)  ($sizeMb MB)"
        Send-Request -Uri $asset.browser_download_url -OutFile $dest
    }

    Write-Log "已同步到 $version"

    # ── 4) 清理过老版本 ──────────────────────────────
    $installers = Get-ChildItem -Path $TargetDir -Filter 'RPA_Pilot-*-setup.exe' -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending

    if ($installers.Count -gt $Keep) {
        foreach ($old in $installers | Select-Object -Skip $Keep) {
            foreach ($suffix in @('', '.blockmap')) {
                $victim = Join-Path $TargetDir ($old.Name + $suffix)
                if (Test-Path $victim) {
                    Remove-Item -LiteralPath $victim -Force
                    Write-Log "清理旧版本：$($old.Name)$suffix"
                }
            }
        }
    }

    # ── 5) 汇总 ──────────────────────────────────────
    $remaining = Get-ChildItem -Path $TargetDir -File -ErrorAction SilentlyContinue |
        Sort-Object Name
    Write-Log "更新目录现状（$($remaining.Count) 个文件）："
    foreach ($f in $remaining) {
        Write-Log ("  {0,-42} {1,8:N1} MB" -f $f.Name, ($f.Length / 1MB))
    }

    Write-Log '同步完成'
    exit 0
} catch {
    Write-Log "同步失败：$($_.Exception.Message)" 'ERROR'
    Write-Log $_.ScriptStackTrace 'ERROR'
    exit 1
}
