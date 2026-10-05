#!/usr/bin/env bash
#
# 把更新产物上传到腾讯云 COS。
#
# 为什么需要它：
#   更新服务器在境外、链路只有几 KB/s，而客户端分布在国内。
#   所以让服务器只做「拉 GitHub + 传 COS」，客户端靠 302 跳转直接从 COS 下载。
#
# 用法：
#   sudo cos-upload.sh                          # 上传 TARGET_DIR 里的产物
#   sudo cos-upload.sh --check                  # 只看会传什么，不真传
#   sudo COS_BUCKET=xxx COS_REGION=ap-guangzhou cos-upload.sh
#
# 上传顺序很重要：
#   先传安装包和 blockmap，**最后**才传 latest.yml。
#   客户端是先读 latest.yml 再按它去取安装包的；如果 latest.yml 先到位，
#   就会有一段时间客户端拿到的是一个指向「还没传完的安装包」的版本清单。
#
set -euo pipefail

TARGET_DIR="${TARGET_DIR:-/swagtslld/RPA_Pilot/updates}"
COS_BUCKET="${COS_BUCKET:-}"
COS_REGION="${COS_REGION:-}"
COS_PREFIX="${COS_PREFIX:-}"
COS_CONFIG="${COS_CONFIG:-/etc/rpa-pilot/cos.yaml}"
LOG_FILE="${LOG_FILE:-/var/log/rpa-pilot-sync.log}"
RETRY="${RETRY:-3}"

CHECK_ONLY=0
FORCE=0

log() {
    local line
    line="$(date '+%Y-%m-%d %H:%M:%S') [COS] $*"
    printf '%s\n' "$line"
    [ -n "$LOG_FILE" ] && printf '%s\n' "$line" >> "$LOG_FILE" 2>/dev/null || true
}

die() { log "错误：$*"; exit 1; }

while [ $# -gt 0 ]; do
    case "$1" in
        --target)   TARGET_DIR="$2"; shift 2 ;;
        --bucket)   COS_BUCKET="$2"; shift 2 ;;
        --region)   COS_REGION="$2"; shift 2 ;;
        --prefix)   COS_PREFIX="$2"; shift 2 ;;
        --config)   COS_CONFIG="$2"; shift 2 ;;
        --check)    CHECK_ONLY=1; shift ;;
        --force)    FORCE=1; shift ;;
        -h|--help)
            sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
            exit 0 ;;
        *) die "未知参数：$1" ;;
    esac
done

[ -d "$TARGET_DIR" ] || die "更新目录不存在：${TARGET_DIR}"
[ -n "$COS_BUCKET" ] || die "没有配置 COS_BUCKET（存储桶名，形如 rpa-pilot-1300000000）"

# ── 选一个上传工具 ──────────────────────────────────────
# coscli 是腾讯云官方的单文件 CLI，首选；coscmd 是 Python 版，作为备选。
if command -v coscli >/dev/null 2>&1; then
    TOOL=coscli
elif command -v coscmd >/dev/null 2>&1; then
    TOOL=coscmd
else
    die "找不到 coscli 或 coscmd。安装 coscli：
       wget https://github.com/tencentyun/coscli/releases/latest/download/coscli-linux -O /usr/local/bin/coscli
       chmod +x /usr/local/bin/coscli"
fi

if [ "$TOOL" = "coscli" ] && [ ! -f "$COS_CONFIG" ]; then
    die "找不到 coscli 配置 ${COS_CONFIG}（里面放 SecretId / SecretKey / 地域）"
fi

if [ "$TOOL" = "coscli" ]; then
    UPLOAD() {  # $1=本地文件 $2=对象键
        coscli cp "$1" "cos://${COS_BUCKET}/${2}" --config "$COS_CONFIG" >/dev/null
    }
else
    UPLOAD() {
        coscmd -b "$COS_BUCKET" -r "$COS_REGION" upload -f "$1" "$2" >/dev/null
    }
fi

# 带重试的上传（跨境/公网都可能抖）
upload_with_retry() {
    local local_file="$1" key="$2" attempt=1
    while [ "$attempt" -le "$RETRY" ]; do
        if UPLOAD "$local_file" "$key"; then
            log "  ✓ $(basename "$local_file") → cos://${COS_BUCKET}/${key}"
            return 0
        fi
        log "  第 ${attempt}/${RETRY} 次上传失败，重试…"
        attempt=$((attempt + 1))
        sleep $((attempt * 3))
    done
    log "  ✗ $(basename "$local_file") 上传失败"
    return 1
}

# ── 收集要传的文件 ──────────────────────────────────────
cd "$TARGET_DIR"

# 只传 latest.yml 里声明的那个版本，不把历史版本一起推上去
PKG=""
if [ -f latest.yml ]; then
    PKG="$(grep -m1 -E '^\s*path:\s*' latest.yml | sed -E 's/^\s*path:\s*//; s/\r$//' || true)"
fi
if [ -z "$PKG" ]; then
    PKG="$(ls -1 RPA_Pilot-*-setup.exe 2>/dev/null | sort -V | tail -1 || true)"
fi
[ -n "$PKG" ] || die "在 ${TARGET_DIR} 里找不到安装包"

# 安装包和它的 blockmap 先传，latest.yml 最后传
FILES=()
FILES+=("$PKG")
[ -f "${PKG}.blockmap" ] && FILES+=("${PKG}.blockmap")
FILES+=("latest.yml")

log "=================================================="
log "上传到 COS：${COS_BUCKET}（${TOOL}）"
for f in "${FILES[@]}"; do
    [ -f "$f" ] && log "  · ${f}  ($(du -h "$f" | cut -f1))"
done

if [ "$CHECK_ONLY" = "1" ]; then
    log "检查模式：以上是将要上传的内容，本次不实际上传"
    exit 0
fi

FAILED=0
for f in "${FILES[@]}"; do
    [ -f "$f" ] || continue
    key="${COS_PREFIX:+${COS_PREFIX%/}/}${f}"
    upload_with_retry "$f" "$key" || FAILED=1
done

if [ "$FAILED" = "1" ]; then
    log "有文件上传失败 —— **不要**以为客户端能更新，latest.yml 可能对应不到安装包"
    exit 1
fi

log "全部上传完成"
log "=================================================="
