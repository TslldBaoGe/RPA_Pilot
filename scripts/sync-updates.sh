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
    sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
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
if ! curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 20 --max-time 120 \
        "${RELEASE_BASE}/latest.yml" -o "${TMP_DIR}/latest.yml"; then
    die "下载 latest.yml 失败：${RELEASE_BASE}/latest.yml（检查仓库是否有 Release、网络是否通）"
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
info "下载 ${PACKAGE}"
# 必须设 --max-time：只设 --connect-timeout 的话，服务器接受连接后卡住不响应，
# curl 会一直挂着，而锁也就一直被占住 —— 之后每次 cron 都只能跳过。
# --speed-limit/--speed-time 进一步防「连上了但传输停滞」。
curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 20 --max-time 1800 \
    --speed-limit 1024 --speed-time 120 \
    "${RELEASE_BASE}/${PACKAGE}" -o "${TMP_DIR}/${PACKAGE}" \
    || die "下载安装包失败：${RELEASE_BASE}/${PACKAGE}"

info "下载 ${BLOCKMAP}"
# blockmap 缺失不该让整个同步失败：没有它只是退化成整包下载，功能不受影响
if ! curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 20 --max-time 300 \
        "${RELEASE_BASE}/${BLOCKMAP}" -o "${TMP_DIR}/${BLOCKMAP}"; then
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
