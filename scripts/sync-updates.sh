#!/usr/bin/env bash
#
# 从 GitHub Release 拉取最新安装包，放进本机 Web 服务器的更新目录。
#
# 客户端定期向这个目录请求 latest.yml。本脚本负责把 GitHub 上最新 Release 的产物
# 同步过来，让「发版」和「客户端更新」之间只差一个 cron。
#
# 为什么由服务器主动「拉」而不是让 GitHub「推」：
#   拉取只需要出站 HTTPS，内网不用开任何入站端口，防火墙那边什么都不用改。
#
# 设计取舍（都是被实际环境逼出来的）：
#   1. 用 releases/latest/download/<文件名> 重定向直下，不走 GitHub API
#      → 不需要 jq 解析 JSON（很多服务器上根本没装 jq）
#      → 公开仓库不需要任何 Token
#   2. 不用 flock（很多精简系统没有），改用 mkdir 原子性做锁
#   3. 下载先落 .new 再 mv —— mv 在同一文件系统内是原子的，
#      客户端不会拿到下到一半的文件
#   4. latest.yml 最后落地 —— 它是客户端检查更新的入口，
#      先放它会让客户端看到一个安装包还没就位的版本
#
# 用法：
#   ./sync-updates.sh                                   # 用默认值
#   ./sync-updates.sh --target /var/www/rpa-pilot --keep 3
#   ./sync-updates.sh --check                           # 只看现在是什么版本，不下载
#   ./sync-updates.sh --force                           # 版本相同也重下（修复损坏的产物）
#   GH_PROXY=https://gh-proxy.com ./sync-updates.sh     # 国内加速：安装包走镜像，latest.yml 仍直连
#   DL_JOBS=8 ./sync-updates.sh                         # 分片并发数（默认 16；设 1 退回单流）
#
# cron（每 15 分钟）：
#   */15 * * * * /usr/local/bin/sync-updates.sh >> /var/log/rpa-pilot-sync.log 2>&1
#
set -euo pipefail

# ── 默认配置（都可以用环境变量或命令行覆盖）────────────────
REPO="${REPO:-TslldBaoGe/RPA_Pilot}"
TARGET_DIR="${TARGET_DIR:-/var/www/rpa-pilot}"
KEEP="${KEEP:-3}"
LOG_FILE="${LOG_FILE:-}"
OWNER="${OWNER:-}"                       # 同步后把文件属主改成它，例如 www-data
RELEASE_BASE="${RELEASE_BASE:-https://github.com/${REPO}/releases/latest/download}"
ASSET_PREFIX="${ASSET_PREFIX:-RPA_Pilot}"  # 安装包名前缀，用于清理旧版本

# 国内服务器直连 GitHub Releases 常常只有几十 KB/s（实测约 65 KB/s，115 MB 要半小时以上）。
# 设 GH_PROXY 走加速镜像：大文件（安装包 / 差量索引）默认走镜像；
# latest.yml 优先直连 GitHub 取（它的版本号与 sha512 是可信来源，用来校验安装包），
# 直连不通时才退回镜像并告警。镜像万一被篡改或下载损坏，会被 sha512 校验拦住。
# 例：GH_PROXY=https://gh-proxy.com（留空则全部直连）
GH_PROXY="${GH_PROXY:-}"

# 进度显示：只有交互终端里才显示，cron / 重定向到日志时保持安静（免得 \r 弄脏日志）。
# 注意：curl 的 -s 会把进度一起吞掉，所以「要进度」和「要安静」是互斥的两套参数，不能同时给。
CURL_QUIET=(-s)
CURL_PROGRESS=()
if [ -t 2 ]; then
    CURL_QUIET=()
    CURL_PROGRESS=(--progress-bar)
fi

# 分片（多连接）下载的并发数。跨境 / 代理链路上单连接被限得很死，
# 多开并发基本线性提速 —— 实测同一条镜像链路下载 10 MB：
#   1 条 86s(121KB/s) / 4 条 33s(319KB/s) / 8 条 18s(576KB/s) / 16 条 10s(1036KB/s) / 32 条 7s(1433KB/s)
# 取 32 作为默认（约 1.4 MB/s，120 MB 约 1.5 分钟）；收益随并发数趋平，再往上意义不大；
# 设 DL_JOBS=1 可关掉分片。
DL_JOBS="${DL_JOBS:-32}"

# 多个加速镜像候选：实际同步前用 2 MB 探测块给每个镜像测速，选最快的一个用。
# 镜像单点故障 / 被限流时这是最有效的兜底 —— 别指望某一个镜像永远好用。
# 全部镜像都不通时才退回直连 GitHub。
GH_MIRRORS="${GH_MIRRORS:-https://gh-proxy.com https://ghfast.top https://ghproxy.net https://github.moeyy.xyz}"

FORCE=0
CHECK_ONLY=0

# ── 日志 ────────────────────────────────────────────────
log() {
    local line
    line="$(date '+%Y-%m-%d %H:%M:%S') [$1] $2"
    echo "$line"
    if [ -n "$LOG_FILE" ]; then
        echo "$line" >> "$LOG_FILE" 2>/dev/null || true
    fi
}
info() { log INFO "$1"; }
warn() { log WARN "$1"; }
die()  { log ERROR "$1"; exit 1; }

usage() {
    # 只打印文件开头的注释块，遇到第一行非注释就停（别把代码也打出来）
    awk 'NR>1 { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "$0"
    exit 0
}

# ── 参数 ────────────────────────────────────────────────
while [ $# -gt 0 ]; do
    case "$1" in
        --repo)     REPO="$2"; RELEASE_BASE="https://github.com/${REPO}/releases/latest/download"; shift 2 ;;
        --target)   TARGET_DIR="$2"; shift 2 ;;
        --keep)     KEEP="$2"; shift 2 ;;
        --log)      LOG_FILE="$2"; shift 2 ;;
        --owner)    OWNER="$2"; shift 2 ;;
        --base)     RELEASE_BASE="$2"; shift 2 ;;   # 便于自测 / GitHub Enterprise
        --force)    FORCE=1; shift ;;
        --check)    CHECK_ONLY=1; shift ;;
        -h|--help)  usage ;;
        *)          die "未知参数：$1（用 --help 看用法）" ;;
    esac
done

command -v curl >/dev/null 2>&1 || die "找不到 curl，请先安装：apt install curl / yum install curl"

# ── 读 latest.yml 里的字段 ──────────────────────────────
# latest.yml 是 electron-builder 生成的固定格式，用 sed 取字段足够，
# 不值得为它引入 yq/jq 依赖
read_field() {
    local file="$1" key="$2"
    sed -n "s/^${key}:[[:space:]]*//p" "$file" 2>/dev/null | head -1 | tr -d '\r' | sed 's/^["'"'"']//; s/["'"'"']$//'
}

# 拼资产下载地址。big=1 且配了镜像时才走镜像（latest.yml 很小，直连即可，且更可信）
asset_url() {
    local name="$1" big="${2:-0}"
    if [ "$big" = "1" ] && [ -n "$GH_PROXY" ]; then
        printf '%s/%s/%s' "${GH_PROXY%/}" "$RELEASE_BASE" "$name"
    else
        printf '%s/%s' "$RELEASE_BASE" "$name"
    fi
}

# 安装包大小写在 latest.yml 的 files[] 下面（有缩进），所以不能直接用 read_field
read_pkg_size() {
    sed -n 's/^[[:space:]]*size:[[:space:]]*//p' "$1" 2>/dev/null | head -1 | tr -d '\r' | tr -cd '0-9'
}

# 字节数格式化，给进度显示用
human() {
    awk -v n="${1:-0}" 'BEGIN {
        if (n >= 1048576) printf "%.1f MB", n / 1048576
        else if (n >= 1024) printf "%.0f KB", n / 1024
        else printf "%d B", n
    }'
}

# 服务器是否支持 Range（分片下载的前提）。小探测一次即可，避免分片时才发现不支持。
supports_range() {
    local code
    code="$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 20 --max-time 30 -r 0-0 "$1" 2>/dev/null || true)"
    [ "$code" = "206" ]
}

# 用 2 MB 探测块实测一个镜像的下载速度（KB/s）。测不出（超时/不支持 Range）返回 0。
# mirror 为空串表示直连。镜像地址拼接遵循 gh-proxy 约定：<镜像>/<原始https地址>。
mirror_speed() {
    local mirror="$1" path="$2" url start end bytes
    if [ -n "$mirror" ]; then
        url="${mirror%/}/${path}"
    else
        url="$path"
    fi
    start=$(date +%s%N)
    bytes="$(curl -s -r 0-2097151 --connect-timeout 8 --max-time 20 -o /dev/null -w '%{size_download}' "$url" 2>/dev/null || echo 0)"
    end=$(date +%s%N)
    case "$bytes" in ''|*[!0-9]*) bytes=0 ;; esac
    [ "$bytes" -gt 0 ] || { echo 0; return; }
    awk -v b="$bytes" -v ns=$((end - start)) 'BEGIN { printf "%d", b * 1000000000 / ns / 1024 }'
}

# 从 GH_MIRRORS 里挑最快的镜像，写进 GH_PROXY（全部不可用则清空 → 退回直连）。
# 显式配了 GH_PROXY（单个镜像）时尊重它，不再测速。
pick_fastest_mirror() {
    [ -n "$GH_PROXY" ] && return
    local best="" best_speed=0 m speed direct_speed
    for m in $GH_MIRRORS; do
        speed="$(mirror_speed "$m" "$RELEASE_BASE/$PACKAGE")"
        info "  测速 ${m}：${speed} KB/s"
        if [ "$speed" -gt "$best_speed" ]; then
            best="$m"; best_speed="$speed"
        fi
    done
    # 镜像全都不可用（或被限到接近 0）时，和直连比一次再定
    if [ "$best_speed" -le 10 ]; then
        direct_speed="$(mirror_speed "" "$RELEASE_BASE/$PACKAGE")"
        info "  测速 直连 GitHub：${direct_speed} KB/s"
        if [ "$direct_speed" -gt "$best_speed" ]; then
            info "镜像全不可用，改用直连 GitHub"
            return
        fi
    fi
    if [ -n "$best" ]; then
        GH_PROXY="$best"
        info "选用最快镜像：${best}（${best_speed} KB/s）"
    else
        info "没有可用镜像，退回直连 GitHub"
    fi
}

# 多连接分片下载。
# 为什么要它：跨境 / 代理链路上单连接常被限速（实测单流约 400 KB/s，120 MB 要 5 分钟），
# 多开几条并发连接通常能把总带宽吃回来。
# 只在「文件够大 + 支持 Range」时启用；任一片失败或片大小对不上就整体放弃，
# 由调用方回退到单流下载 —— 宁可慢，也不能拼出个残缺文件。
download_segments() {
    local url="$1" dest="$2" size="$3" jobs="${4:-4}" max_time="${5:-1800}"

    [ "$jobs" -gt 1 ] || return 1
    case "$size" in ''|*[!0-9]*) return 1 ;; esac
    [ "$size" -ge 4194304 ] || return 1      # 小于 4 MB 不值得分片
    supports_range "$url" || return 1

    local dir; dir="$(mktemp -d)" || return 1
    local chunk=$(( (size + jobs - 1) / jobs ))
    local pids=() i start end part
    for ((i = 0; i < jobs; i++)); do
        start=$(( i * chunk ))
        [ "$start" -ge "$size" ] && break
        end=$(( start + chunk - 1 ))
        [ "$end" -ge "$size" ] && end=$(( size - 1 ))
        # 文件名补零，保证 cat 拼接时顺序正确
        part="$(printf '%s/part.%03d' "$dir" "$i")"
        curl -fL "${CURL_QUIET[@]+"${CURL_QUIET[@]}"}" --connect-timeout 20 --max-time "$max_time" \
            --speed-limit 512 --speed-time 60 -r "${start}-${end}" "$url" -o "$part" &
        pids+=("$!")
    done
    [ "${#pids[@]}" -gt 0 ] || { rm -rf "$dir"; return 1; }

    # 终端下用 \r 原地刷新聚合进度；非终端（cron 进日志）每 10% 写一行日志，
    # 这样看日志文件也能知道下载在推进，而不是卡在一条「下载中」上。
    if [ "${#CURL_PROGRESS[@]}" -gt 0 ]; then
        local got alive f p
        while :; do
            got=0; alive=0
            for f in "$dir"/part.*; do
                [ -f "$f" ] && got=$(( got + $(stat -c %s "$f" 2>/dev/null || echo 0) ))
            done
            printf '\r    %s / %s (%d%%)   ' "$(human "$got")" "$(human "$size")" "$(( got * 100 / size ))"
            for p in "${pids[@]}"; do kill -0 "$p" 2>/dev/null && alive=1; done
            [ "$alive" = "0" ] && break
            sleep 1
        done
        printf '\n'
    else
        local got last_pct=-10 alive f p
        while :; do
            got=0; alive=0
            for f in "$dir"/part.*; do
                [ -f "$f" ] && got=$(( got + $(stat -c %s "$f" 2>/dev/null || echo 0) ))
            done
            local pct=$(( got * 100 / size ))
            # 每跨过一个 10% 的坎记一次；日志里能看出来在动就行，不用每 1% 刷屏
            if [ "$pct" -ge $(( last_pct + 10 )) ]; then
                info "  下载进度 ${pct}%（$(human "$got") / $(human "$size")）"
                last_pct=$(( pct / 10 * 10 ))
            fi
            for p in "${pids[@]}"; do kill -0 "$p" 2>/dev/null && alive=1; done
            [ "$alive" = "0" ] && break
            sleep 2
        done
    fi

    local failed=0 p
    for p in "${pids[@]}"; do wait "$p" || failed=1; done
    [ "$failed" = "1" ] && { rm -rf "$dir"; return 1; }

    local total=0 f
    for f in "$dir"/part.*; do
        [ -f "$f" ] && total=$(( total + $(stat -c %s "$f" 2>/dev/null || echo 0) ))
    done
    if [ "$total" != "$size" ]; then
        warn "分片总大小 ${total} 与期望 ${size} 不符，放弃分片结果"
        rm -rf "$dir"; return 1
    fi

    cat "$dir"/part.* > "$dest" || { rm -rf "$dir"; return 1; }
    rm -rf "$dir"
    return 0
}

# 校验安装包的 sha512（latest.yml 里存的是 base64）。校验工具缺失时告警并跳过，不阻塞同步。
verify_sha512() {
    local file="$1" expected="$2"
    [ -n "$expected" ] || return 0
    command -v openssl >/dev/null 2>&1 || { warn "没有 openssl，跳过 sha512 校验"; return 0; }
    local got
    got="$(openssl dgst -sha512 -binary "$file" 2>/dev/null | openssl base64 -A 2>/dev/null || true)"
    [ -n "$got" ] || { warn "计算 sha512 失败，跳过校验"; return 0; }
    [ "$got" = "$expected" ]
}

# 下载一个资产。逐级回退：镜像分片 → 镜像单流 → 直连分片 → 直连单流。
# size 已知（来自 latest.yml）且服务器支持 Range 时才会走分片。
download_asset() {
    local name="$1" dest="$2" max_time="$3" size="${4:-0}"
    local url jobs_note=""

    # 大小已知且够大才可能分片；小文件（如 blockmap）不必刷「多少条连接」
    if [ -n "$size" ] && [ "$size" -ge 4194304 ] 2>/dev/null; then
        jobs_note="，最多 ${DL_JOBS} 条连接"
    fi

    if [ -n "$GH_PROXY" ]; then
        url="$(asset_url "$name" 1)"
        info "下载 ${name}（加速镜像 ${GH_PROXY}${jobs_note}）"
        if download_segments "$url" "$dest" "$size" "$DL_JOBS" "$max_time"; then
            info "  分片下载完成"
            return 0
        fi
        if [ -n "$jobs_note" ]; then
            warn "分片不可用或失败，改用单流下载"
        fi
        if curl -fL "${CURL_QUIET[@]+"${CURL_QUIET[@]}"}" "${CURL_PROGRESS[@]+"${CURL_PROGRESS[@]}"}" \
                --retry 2 --retry-delay 2 --connect-timeout 20 --max-time "$max_time" \
                --speed-limit 1024 --speed-time 120 "$url" -o "$dest"; then
            return 0
        fi
        warn "镜像下载 ${name} 失败，改直连 GitHub 重试"
    else
        info "下载 ${name}${jobs_note}"
    fi

    url="$(asset_url "$name" 0)"
    if download_segments "$url" "$dest" "$size" "$DL_JOBS" "$max_time"; then
        info "  分片下载完成"
        return 0
    fi
    curl -fL "${CURL_QUIET[@]+"${CURL_QUIET[@]}"}" "${CURL_PROGRESS[@]+"${CURL_PROGRESS[@]}"}" \
        --retry 3 --retry-delay 2 --connect-timeout 20 --max-time "$max_time" \
        --speed-limit 1024 --speed-time 120 "$url" -o "$dest"
}

info "开始同步：仓库 $REPO → 目标目录 $TARGET_DIR"

mkdir -p "$TARGET_DIR" || die "无法创建目标目录 $TARGET_DIR"

# 用 mkdir 做锁：它在所有文件系统上都是原子操作，不需要 flock。
# 但不能只会「加锁」—— 进程被 kill 或机器断电时锁目录会留下来，
# 那样之后每次 cron 都会「跳过」，更新就无声无息地永久停掉了。
# 所以锁里记下持有者的 PID，发现持有者已经不在了就自动清理。
LOCK_DIR="${TARGET_DIR}/.sync-lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    HOLDER=""
    [ -f "${LOCK_DIR}/pid" ] && HOLDER="$(cat "${LOCK_DIR}/pid" 2>/dev/null || true)"

    if [ -n "$HOLDER" ] && kill -0 "$HOLDER" 2>/dev/null; then
        warn "上一次同步（PID ${HOLDER}）还在进行，本次跳过"
        exit 0
    fi

    if [ -n "$HOLDER" ]; then
        warn "发现陈旧锁：持有者 PID ${HOLDER} 已不存在，自动清理后继续"
    else
        warn "发现陈旧锁：没有 PID 记录（多半是旧版本或被强杀留下的），自动清理后继续"
    fi

    rm -rf "$LOCK_DIR"
    mkdir "$LOCK_DIR" 2>/dev/null || { warn "清理陈旧锁后仍无法加锁，本次跳过"; exit 0; }
fi
echo $$ > "${LOCK_DIR}/pid"

TMP_DIR=""
cleanup() {
    rmdir "$LOCK_DIR" 2>/dev/null || true
    [ -n "$TMP_DIR" ] && rm -rf "$TMP_DIR"
}
trap cleanup EXIT

TMP_DIR="$(mktemp -d)" || die "无法创建临时目录"

# ── 1) 先把 latest.yml 下到临时目录（注意：只是下载，还没发布）──
info "读取远端最新版本信息"
# 优先直连 GitHub：latest.yml 很小，直连拿到的是「可信来源」的版本号与 sha512，
# 后面用它校验安装包，能顺带发现镜像被篡改。
# 直连不通（国内网络很常见）再退回镜像，此时可信度降低，会明确告警。
if ! curl -fsSL --retry 2 --retry-delay 2 --connect-timeout 10 --max-time 30 \
        "${RELEASE_BASE}/latest.yml" -o "${TMP_DIR}/latest.yml"; then
    if [ -n "$GH_PROXY" ]; then
        warn "直连 GitHub 取 latest.yml 失败，改走加速镜像（此版本信息来自镜像，可信度略降）"
        curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 20 --max-time 60 \
            "$(asset_url "latest.yml" 1)" -o "${TMP_DIR}/latest.yml" \
            || die "下载 latest.yml 失败（直连与镜像都不通，检查仓库是否有 Release、网络是否通）"
    else
        die "下载 latest.yml 失败：${RELEASE_BASE}/latest.yml（检查仓库是否有 Release、网络是否通）"
    fi
fi

VERSION="$(read_field "${TMP_DIR}/latest.yml" version)"
[ -n "$VERSION" ] || die "latest.yml 里读不到 version 字段，内容可能不对"

# path 就是 electron-updater 实际会去下载的文件名，直接用它最可靠
PACKAGE="$(read_field "${TMP_DIR}/latest.yml" path)"
[ -n "$PACKAGE" ] || PACKAGE="${ASSET_PREFIX}-${VERSION}-setup.exe"
BLOCKMAP="${PACKAGE}.blockmap"

info "GitHub 上最新版本：${VERSION}（包名 ${PACKAGE}）"

# ── 2) 和已发布的比一比 ─────────────────────────────────
PUBLISHED=""
if [ -f "${TARGET_DIR}/latest.yml" ]; then
    PUBLISHED="$(read_field "${TARGET_DIR}/latest.yml" version)"
fi

if [ -n "$PUBLISHED" ]; then
    info "本地更新目录当前版本：${PUBLISHED}"
else
    info "本地更新目录还没有 latest.yml，本次是首次同步"
fi

if [ "$PUBLISHED" = "$VERSION" ] && [ "$FORCE" -eq 0 ]; then
    info "版本一致，无需更新（要强制重下加 --force）"
    exit 0
fi

if [ "$CHECK_ONLY" -eq 1 ]; then
    info "检查模式：本次应同步 ${PUBLISHED:-无} → ${VERSION}"
    exit 0
fi

# ── 3) 下载安装包与差量索引 ─────────────────────────────
# 必须设 --max-time：只设 --connect-timeout 的话，服务器接受连接后卡住不响应，
# curl 会一直挂着，而锁也就一直被占住 —— 之后每次 cron 都只能跳过。
# --speed-limit/--speed-time 进一步防「连上了但传输停滞」。
# 安装包大小取自 latest.yml，用来做多连接分片；没有就退回单流。
PKG_SIZE="$(read_pkg_size "${TMP_DIR}/latest.yml")"

# 下载前给候选镜像测速，选最快的一个（显式配了 GH_PROXY 则跳过测速）。
# 这一步把「某个镜像被限流/故障导致同步龟速」从排查题变成自动绕行。
info "挑选最快的下载镜像…"
pick_fastest_mirror

download_asset "${PACKAGE}" "${TMP_DIR}/${PACKAGE}" 1800 "$PKG_SIZE" \
    || die "下载安装包失败：${RELEASE_BASE}/${PACKAGE}"

# 校验 sha512：latest.yml 是直连 GitHub 取的（可信来源），拿它来验安装包。
# 安装包若走了镜像，这一步能同时发现「被篡改」和「下载损坏」。
EXPECT_SHA="$(read_field "${TMP_DIR}/latest.yml" sha512)"
if [ -n "$EXPECT_SHA" ]; then
    if verify_sha512 "${TMP_DIR}/${PACKAGE}" "$EXPECT_SHA"; then
        info "安装包 sha512 校验通过"
    else
        rm -f "${TMP_DIR}/${PACKAGE}"
        die "安装包 sha512 与 latest.yml 声明不一致（下载损坏，或镜像不可信）"
    fi
else
    warn "latest.yml 里没有 sha512 字段，跳过校验"
fi

# blockmap 缺失不该让整个同步失败：没有它只是退化成整包下载，功能不受影响
if ! download_asset "${BLOCKMAP}" "${TMP_DIR}/${BLOCKMAP}" 300; then
    warn "下载 blockmap 失败，将跳过差量索引（客户端会整包下载）"
    rm -f "${TMP_DIR}/${BLOCKMAP}"
fi

# ── 4) 落地：先安装包，latest.yml 最后 ──────────────────
# 先写 .new 再 mv：mv 在同一文件系统内是原子的，客户端不会读到半截文件
place() {
    local name="$1"
    install -m 0644 "${TMP_DIR}/${name}" "${TARGET_DIR}/${name}.new" || die "写入 ${name} 失败"
    mv -f "${TARGET_DIR}/${name}.new" "${TARGET_DIR}/${name}" || die "替换 ${name} 失败"
    info "已就位 ${name}"
}

if [ -f "${TMP_DIR}/${BLOCKMAP}" ]; then
    place "${BLOCKMAP}"
fi
place "${PACKAGE}"

info "最后更新 latest.yml（客户端从这里发现新版本）"
place "latest.yml"

# ── 5) 清理过老版本 ─────────────────────────────────────
# 保留几个历史版本是为了回滚：electron-updater 不降级，
# 回滚要靠「把旧代码打成更高的版本号重新发布」，所以旧包别急着删
if [ "$KEEP" -gt 0 ]; then
    # shellcheck disable=SC2012
    old="$(ls -1t "${TARGET_DIR}"/${ASSET_PREFIX}-*-setup.exe 2>/dev/null | tail -n +$((KEEP + 1)) || true)"
    if [ -n "$old" ]; then
        while IFS= read -r f; do
            [ -n "$f" ] || continue
            rm -f "$f" "${f}.blockmap"
            info "清理旧版本 $(basename "$f")"
        done <<< "$old"
    fi
fi

if [ -n "$OWNER" ]; then
    # 只改本脚本写入的那几个文件，**不要** chown -R 整个目录：
    # 更新目录里可能还放着别的东西（比如克隆下来的仓库），
    # 递归改属主会把它们一起改掉，是个很隐蔽的坑。
    for f in latest.yml "${PACKAGE}" "${BLOCKMAP}"; do
        target="${TARGET_DIR}/${f}"
        if [ -e "$target" ]; then
            chmod 0644 "$target" 2>/dev/null || true
            chown "${OWNER}" "$target" 2>/dev/null || warn "chown ${OWNER} ${f} 失败（可能需要 root）"
        fi
    done
fi

# ── 6) 汇总 ─────────────────────────────────────────────
info "更新目录现状："
ls -lh "$TARGET_DIR" 2>/dev/null | tail -n +2 | while IFS= read -r line; do
    info "  $line"
done

info "同步完成：${PUBLISHED:-无} → ${VERSION}"
