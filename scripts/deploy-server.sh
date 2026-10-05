#!/usr/bin/env bash
#
# RPA_Pilot 更新服务器一键部署（Linux）。
#
# 用法（在仓库里执行，可反复运行，幂等）：
#     git pull
#     sudo bash scripts/deploy-server.sh
#
# 它做的事：
#   1. 建更新目录
#   2. 装拉取脚本到 /usr/local/bin
#   3. 在指定端口上提供 HTTP 服务（默认用独立 Docker 容器，**不碰宿主机 nginx**）
#   4. 放行端口（自动识别 firewalld / ufw）
#   5. 生成便捷命令 rpa-sync（默认不装 cron，由你手动执行）
#   6. 跑一次 --check 验证能连上 GitHub
#
# 可用环境变量覆盖默认值：
#   REPO=owner/repo PORT=8088 TARGET_DIR=/path/to/updates KEEP=3
#   SERVE_MODE=docker|nginx|none|auto   默认 auto（有 docker 就用容器）
#   CONTAINER_NAME=rpa-pilot-updates IMAGE=nginx:alpine
#   WEB_USER=nginx LOG_FILE=/var/log/rpa-pilot-sync.log
#   WRAPPER_PATH=/usr/local/bin/rpa-sync   便捷命令的位置
#   ENABLE_CRON=1                        想让服务器每 15 分钟自动拉时才需要
#   NGINX_START=1                        仅在 SERVE_MODE=nginx 时用于「启动宿主机 nginx」
#   SKIP_FIREWALL=1 SKIP_CHECK=1 NGINX_MODE=skip
#
# 把产物放到对象存储（推荐：服务器只回 302，字节由 COS 直出）：
#   COS_BUCKET=rpa-pilot-1300000000 COS_REGION=ap-guangzhou \
#   COS_SECRET_ID=xxx COS_SECRET_KEY=xxx \
#   sudo -E bash scripts/deploy-server.sh
#   可选：COS_PREFIX=updates（对象键前缀）、COS_BASE=https://自定义域名
#
set -euo pipefail

# ── 默认配置 ────────────────────────────────────────────
REPO="${REPO:-TslldBaoGe/RPA_Pilot}"
PORT="${PORT:-8088}"
SERVER_NAME="${SERVER_NAME:-_}"
KEEP="${KEEP:-3}"
LOG_FILE="${LOG_FILE:-/var/log/rpa-pilot-sync.log}"
NGINX_CONF="${NGINX_CONF:-/etc/nginx/conf.d/rpa-pilot.conf}"
BIN_PATH="${BIN_PATH:-/usr/local/bin/sync-updates.sh}"
WRAPPER_PATH="${WRAPPER_PATH:-/usr/local/bin/rpa-sync}"
CRON_SCHEDULE="${CRON_SCHEDULE:-*/15 * * * *}"
# 默认不装 cron，改由人工执行 rpa-sync；要定时自动拉就设 ENABLE_CRON=1
ENABLE_CRON="${ENABLE_CRON:-0}"

# ── 可选：把产物放到对象存储，服务器只做 302 跳转 ──────────
# 为什么要这样：更新服务器在境外、跨境链路实测只有几 KB/s ~ 几百 KB/s，
# 而客户端在国内。让服务器只回一个 302，实际字节由 COS 直出，
# 客户端速度能到 MB/s，服务器也不再有带宽压力。
#
# 设了 COS_BUCKET（+ COS_REGION）就启用；不设则维持「服务器本地提供文件」。
# COS_BASE 一般不用手填，会按 bucket+region 推出来；用自定义域名时再覆盖。
COS_BUCKET="${COS_BUCKET:-}"
COS_REGION="${COS_REGION:-ap-guangzhou}"
COS_PREFIX="${COS_PREFIX:-}"
COS_BASE="${COS_BASE:-}"
COS_CONF_FILE="${COS_CONF_FILE:-/etc/rpa-pilot/redirect.conf}"
COS_CLI_CONFIG="${COS_CLI_CONFIG:-/etc/rpa-pilot/cos.yaml}"
COS_UPLOAD_BIN="${COS_UPLOAD_BIN:-/usr/local/bin/cos-upload.sh}"

# 默认用独立容器提供服务：和宿主机上已有的站点（尤其是别人的 Docker 容器）完全隔离。
# 很多机器上 80 端口属于另一个项目，动宿主机 nginx 容易把别人的站搞挂。
SERVE_MODE="${SERVE_MODE:-auto}"
CONTAINER_NAME="${CONTAINER_NAME:-rpa-pilot-updates}"
IMAGE="${IMAGE:-nginx:alpine}"
NGINX_START="${NGINX_START:-0}"

SKIP_FIREWALL="${SKIP_FIREWALL:-0}"
SKIP_CHECK="${SKIP_CHECK:-0}"
NGINX_MODE="${NGINX_MODE:-auto}"     # auto | skip

# ── 输出 ────────────────────────────────────────────────
step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
ok()   { printf '    \033[32m✓\033[0m %s\n' "$1"; }
info() { printf '    · %s\n' "$1"; }
warn() { printf '    \033[33m!\033[0m %s\n' "$1"; }
die()  { printf '\n\033[1;31m✗ %s\033[0m\n\n' "$1"; exit 1; }

# ── 前置检查 ────────────────────────────────────────────
[ "$(id -u)" -eq 0 ] || die "需要 root 权限，请用：sudo bash scripts/deploy-server.sh"

command -v curl >/dev/null 2>&1 || die "缺少 curl，请先安装：apt install curl / yum install curl"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SYNC_SRC="${SCRIPT_DIR}/sync-updates.sh"

# 正常情况下本脚本和 sync-updates.sh 都在 <仓库>/scripts/ 下。
# 如果只把本脚本单独拷到服务器上跑，就从 GitHub 兜底拉一份（公开仓库，不需要 Token）。
if [ ! -f "$SYNC_SRC" ]; then
    warn "同目录下没找到 sync-updates.sh，尝试从 GitHub 拉取"
    SYNC_SRC="/tmp/sync-updates.sh.$$"
    curl -fsSL -o "$SYNC_SRC" "https://raw.githubusercontent.com/${REPO}/main/scripts/sync-updates.sh" \
        || die "拉取失败。请确认在仓库目录里执行（git pull 后再跑），或服务器能访问 github.com"
    ok "已从 GitHub 获取 sync-updates.sh"
fi

# 更新目录默认放在仓库下的 updates/（已在 .gitignore 里）。
# 故意**不用** /usr/share/nginx/html 之类共享目录：那里往往放着别人的站点文件，
# 既容易互相干扰，也可能把不该公开的东西一起挂出去。
TARGET_DIR="${TARGET_DIR:-${REPO_ROOT}/updates}"

# COS 的对外访问域名：设了 COS_BUCKET 就自动推导（COS_BASE 可覆盖，用于自定义域名）
if [ -n "$COS_BUCKET" ] && [ -z "$COS_BASE" ]; then
    COS_BASE="https://${COS_BUCKET}.cos.${COS_REGION}.myqcloud.com"
fi

# 把 COS_BASE 拆成「源」和「路径前缀」两部分，拼 302 目标时才不会重复或漏掉斜杠
COS_ORIGIN=""
COS_PATH_PREFIX=""
if [ -n "$COS_BASE" ]; then
    COS_ORIGIN="$COS_BASE"
    case "$COS_ORIGIN" in
        *://*) ;;
        *) COS_ORIGIN="https://${COS_ORIGIN}" ;;
    esac
    # 协议 + 主机之后若还有路径，就是对象键前缀
    COS_REST="${COS_ORIGIN#*://}"
    case "$COS_REST" in
        */*)
            COS_ORIGIN="${COS_ORIGIN%%/${COS_REST#*/}}"
            COS_PATH_PREFIX="/${COS_REST#*/}"
            COS_PATH_PREFIX="${COS_PATH_PREFIX%/}"
            ;;
    esac
    if [ -n "$COS_PREFIX" ]; then
        COS_PATH_PREFIX="${COS_PATH_PREFIX}/${COS_PREFIX#/}"
        COS_PATH_PREFIX="${COS_PATH_PREFIX%/}"
    fi
fi

USE_COS=0
[ -n "$COS_BUCKET" ] && USE_COS=1

# 自动识别 Web 服务账号：不同发行版不一样
detect_web_user() {
    for candidate in nginx www-data apache httpd; do
        if id "$candidate" >/dev/null 2>&1; then
            echo "$candidate"
            return
        fi
    done
    echo root
}
WEB_USER="${WEB_USER:-$(detect_web_user)}"

printf '\033[1mRPA_Pilot 更新服务器部署\033[0m\n'
info "仓库      : ${REPO}"
info "仓库目录  : ${REPO_ROOT}"
info "更新目录  : ${TARGET_DIR}"
info "监听端口  : ${PORT}"
info "提供服务  : ${SERVE_MODE}（auto = 有 docker 就用独立容器）"
if [ "$USE_COS" = "1" ]; then
    info "产物分发  : 302 跳转到 COS → ${COS_BASE}"
    info "            （客户端实际字节由 COS 直出，不再占用本机带宽）"
else
    info "产物分发  : 本机直接提供文件"
fi

# ── 1) 更新目录 ─────────────────────────────────────────
step "1/6 准备更新目录"
if [ -d "$TARGET_DIR" ]; then
    info "${TARGET_DIR} 已存在，不改动属主与权限"
    info "当前：$(stat -c '%A %U:%G' "$TARGET_DIR" 2>/dev/null || echo '无法读取')"
else
    mkdir -p "$TARGET_DIR"
    chmod 755 "$TARGET_DIR"
    ok "已创建 ${TARGET_DIR}"
fi

# ── 2) 安装拉取脚本 ─────────────────────────────────────
step "2/6 安装拉取脚本"
install -m 0755 "$SYNC_SRC" "$BIN_PATH"
ok "${BIN_PATH}"
bash -n "$BIN_PATH" || die "拉取脚本语法检查失败"
ok "语法检查通过"

# 再放一个「包装命令」，把仓库地址、更新目录、属主都固定进去。
# 这样手动同步只要敲 rpa-sync 就行，不用每次记一堆参数 ——
# 而且能避免一个坑：sync-updates.sh 自己的默认目录是 /var/www/rpa-pilot，
# 不带参数直接跑会同步到错的地方。
cat > "$WRAPPER_PATH" <<EOF
#!/usr/bin/env bash
# 由 scripts/deploy-server.sh 生成。
# 用法：sudo rpa-sync            （拉取最新版$([ "$USE_COS" = "1" ] && echo "，并上传到 COS")）
#       sudo rpa-sync --check    （只看远端是什么版本，不下载、不上传）
#       sudo rpa-sync --force    （版本相同也重下，用于修复损坏的产物）
set -euo pipefail

# --check 只查版本，不要顺手往 COS 传东西
UPLOAD=1
for arg in "\$@"; do
  [ "\$arg" = "--check" ] && UPLOAD=0
done

${BIN_PATH} \\
  --target '${TARGET_DIR}' \\
  --owner '${WEB_USER}' \\
  --keep '${KEEP}' \\
  "\$@"
EOF
if [ "$USE_COS" = "1" ]; then
    cat >> "$WRAPPER_PATH" <<EOF

if [ "\$UPLOAD" = "1" ]; then
  ${COS_UPLOAD_BIN} \\
    --target '${TARGET_DIR}' \\
    --bucket '${COS_BUCKET}' \\
    --region '${COS_REGION}' \\
    --config '${COS_CLI_CONFIG}'
fi
EOF
fi
chmod 0755 "$WRAPPER_PATH"
ok "已生成便捷命令 ${WRAPPER_PATH}"

# ── 启用了 COS：安装上传脚本 + 写 coscli 凭据 ────────────
if [ "$USE_COS" = "1" ]; then
    COS_SRC="${SCRIPT_DIR}/cos-upload.sh"
    if [ ! -f "$COS_SRC" ]; then
        warn "同目录下没找到 cos-upload.sh，尝试从 GitHub 拉取"
        COS_SRC="/tmp/cos-upload.sh.$$"
        curl -fsSL -o "$COS_SRC" "https://raw.githubusercontent.com/${REPO}/main/scripts/cos-upload.sh" \
            || die "拉取 cos-upload.sh 失败（确认服务器能访问 github.com）"
        ok "已从 GitHub 获取 cos-upload.sh"
    fi
    install -m 0755 "$COS_SRC" "$COS_UPLOAD_BIN"
    bash -n "$COS_UPLOAD_BIN" || die "cos-upload.sh 语法检查失败"
    ok "${COS_UPLOAD_BIN}"

    mkdir -p "$(dirname "$COS_CLI_CONFIG")"
    if [ -n "${COS_SECRET_ID:-}" ] && [ -n "${COS_SECRET_KEY:-}" ]; then
        cat > "$COS_CLI_CONFIG" <<YAML
cos:
  base:
    secretid: ${COS_SECRET_ID}
    secretkey: ${COS_SECRET_KEY}
    protocol: https
  buckets:
    - name: ${COS_BUCKET}
      alias: rpapilot
      region: ${COS_REGION}
YAML
        chmod 600 "$COS_CLI_CONFIG"
        ok "已写入 ${COS_CLI_CONFIG}（权限 600，含密钥）"
    elif [ -f "$COS_CLI_CONFIG" ]; then
        info "${COS_CLI_CONFIG} 已存在，保留现有凭据"
        info "（要换密钥就带 COS_SECRET_ID / COS_SECRET_KEY 重跑本脚本）"
    else
        warn "没有提供 COS_SECRET_ID / COS_SECRET_KEY，${COS_CLI_CONFIG} 未创建"
        warn "上传会失败。请去腾讯云 → 访问管理 → API 密钥 建一对（建议用子账号，只给这个桶的读写权限）"
    fi

    if ! command -v coscli >/dev/null 2>&1 && ! command -v coscmd >/dev/null 2>&1; then
        warn "服务器上还没有 coscli。上传脚本会报错，先装它："
        info "  curl -fsSL -o /usr/local/bin/coscli https://github.com/tencentyun/coscli/releases/latest/download/coscli-linux"
        info "  chmod +x /usr/local/bin/coscli"
        info "（github.com 拉不动的话，在能上网的机器下好再 scp 上去）"
    fi
fi

# ── 3) 提供 HTTP 服务 ───────────────────────────────────
step "3/6 提供 HTTP 服务（端口 ${PORT}）"

# 用独立容器提供静态文件服务。
# 只把更新目录挂进去当网站根：目录里本来就只有 latest.yml / exe / blockmap，
# 所以不需要额外写「只放行哪些路径」的配置，别的文件压根不存在。
# 全程不碰宿主机 nginx，也不碰 80 端口上属于别的项目的容器。
setup_docker_serving() {
    command -v docker >/dev/null 2>&1 || { warn "没有 docker 命令"; return 1; }
    docker info >/dev/null 2>&1 || { warn "docker 守护进程没响应（没启动或权限不足）"; return 1; }

    if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
        info "本地没有镜像 ${IMAGE}，尝试拉取…"
        if docker pull "$IMAGE" >/dev/null 2>&1; then
            ok "已拉取 ${IMAGE}"
        else
            local alt
            alt="$(docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep -i 'nginx' | grep -v '<none>' | head -1 || true)"
            if [ -n "$alt" ]; then
                warn "拉取 ${IMAGE} 失败，改用本地已有的镜像：${alt}"
                IMAGE="$alt"
            else
                warn "拉取 ${IMAGE} 失败，且本地没有别的 nginx 镜像"
                return 1
            fi
        fi
    fi

    if docker inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
        local cur_port cur_src cur_conf running
        cur_port="$(docker inspect -f '{{range .HostConfig.PortBindings}}{{range .}}{{.HostPort}}{{end}}{{end}}' "$CONTAINER_NAME" 2>/dev/null || true)"
        cur_src="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/usr/share/nginx/html"}}{{.Source}}{{end}}{{end}}' "$CONTAINER_NAME" 2>/dev/null || true)"
        cur_conf="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/etc/nginx/conf.d/default.conf"}}{{.Source}}{{end}}{{end}}' "$CONTAINER_NAME" 2>/dev/null || true)"
        running="$(docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null || echo false)"

        local want_conf=""
        [ "$USE_COS" = "1" ] && want_conf="$COS_CONF_FILE"

        if [ "$cur_port" = "$PORT" ] && [ "$cur_src" = "$TARGET_DIR" ] && [ "$cur_conf" = "$want_conf" ]; then
            if [ "$running" = "true" ]; then
                ok "容器 ${CONTAINER_NAME} 已在运行且参数一致，无需改动"
                # 配置内容可能变了（比如刚切到 COS），nginx 只在启动时读配置
                if [ "$USE_COS" = "1" ] && [ "$conf_changed" = "1" ]; then
                    docker restart "$CONTAINER_NAME" >/dev/null && ok "配置有更新，已重启容器使其生效"
                fi
            else
                docker start "$CONTAINER_NAME" >/dev/null && ok "已启动已有容器 ${CONTAINER_NAME}"
            fi
            return 0
        fi

        warn "已有容器 ${CONTAINER_NAME} 的参数与本次不同，将重建"
        info "  现有：端口 ${cur_port:-?}，目录 ${cur_src:-?}，配置 ${cur_conf:-（无）}"
        info "  目标：端口 ${PORT}，目录 ${TARGET_DIR}，配置 ${want_conf:-（无）}"
        docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || { warn "删除旧容器失败"; return 1; }
    fi

    if [ "$USE_COS" = "1" ]; then
        docker run -d --name "$CONTAINER_NAME" --restart unless-stopped \
            -p "${PORT}:80" \
            -v "${TARGET_DIR}:/usr/share/nginx/html:ro" \
            -v "${COS_CONF_FILE}:/etc/nginx/conf.d/default.conf:ro" \
            "$IMAGE" >/dev/null || { warn "创建容器失败"; return 1; }
        ok "已启动容器 ${CONTAINER_NAME}（镜像 ${IMAGE}，宿主 ${PORT} → 容器 80）"
        info "挂载：${TARGET_DIR} → /usr/share/nginx/html（只读）"
        info "      ${COS_CONF_FILE} → /etc/nginx/conf.d/default.conf（只读，302 跳转规则）"
    else
        docker run -d --name "$CONTAINER_NAME" --restart unless-stopped \
            -p "${PORT}:80" \
            -v "${TARGET_DIR}:/usr/share/nginx/html:ro" \
            "$IMAGE" >/dev/null || { warn "创建容器失败"; return 1; }
        ok "已启动容器 ${CONTAINER_NAME}（镜像 ${IMAGE}，宿主 ${PORT} → 容器 80）"
        info "挂载：${TARGET_DIR} → /usr/share/nginx/html（只读）"
    fi
}

# 用宿主机 nginx 提供服务（备选方案；不会主动启动或重启它）
setup_nginx_serving() {
    if ! command -v nginx >/dev/null 2>&1; then
        warn "系统里没有 nginx。改用 SERVE_MODE=docker，或装好 nginx 后重跑"
        return 1
    fi

    render_server_block() {
        if [ "$USE_COS" = "1" ]; then
            cat <<EOF
# 由 scripts/deploy-server.sh 生成，请勿手工修改（会被覆盖）
# 只做 302 跳转到 COS，实际字节不经过本机
server {
    listen ${PORT};
    server_name ${SERVER_NAME};

    location = /latest.yml {
        add_header Cache-Control "no-store" always;
        return 302 ${COS_ORIGIN}${COS_PATH_PREFIX}/latest.yml;
    }

    location ~ ^/(RPA_Pilot-[^/]+\.exe|RPA_Pilot-[^/]+\.exe\.blockmap)\$ {
        return 302 ${COS_ORIGIN}${COS_PATH_PREFIX}\$uri;
    }

    location / {
        return 404;
    }
}
EOF
            return
        fi

        cat <<EOF
# 由 scripts/deploy-server.sh 生成，请勿手工修改（会被覆盖）
server {
    listen ${PORT};
    server_name ${SERVER_NAME};

    root ${TARGET_DIR};
    autoindex off;

    location ~ ^/(latest\.yml|RPA_Pilot-[^/]+\.exe|RPA_Pilot-[^/]+\.exe\.blockmap)\$ {
        try_files \$uri =404;
        add_header Cache-Control "no-store" always;
    }

    location / {
        return 404;
    }
}
EOF
    }

    # 探测 nginx 是谁在管：systemd 管的，还是宝塔 / 1Panel / Docker / 手工启动的
    local managed_by_systemd=0 running_pid="" running_bin=""
    if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet nginx 2>/dev/null; then
        managed_by_systemd=1
    fi
    if [ "$managed_by_systemd" = "0" ] && command -v pgrep >/dev/null 2>&1; then
        running_pid="$(pgrep -f 'nginx: master process' 2>/dev/null | head -1 || true)"
        [ -n "$running_pid" ] || running_pid="$(pgrep -x nginx 2>/dev/null | head -1 || true)"
        [ -n "$running_pid" ] && running_bin="$(readlink -f "/proc/${running_pid}/exe" 2>/dev/null || true)"
    fi

    if [ "$managed_by_systemd" = "0" ] && [ -n "$running_pid" ]; then
        printf '\n'
        warn "检测到正在运行的 nginx 不归 systemd 管（PID ${running_pid}，二进制 ${running_bin:-未知}）"
        warn "【已跳过】—— /etc/nginx/conf.d 多半不是它的配置目录，盲写不会生效还可能弄坏现有站点。"
        printf '\n'
        info "请手工把下面这段加到它的配置里："
        render_server_block | sed 's/^/      /'
        printf '\n'
        info "然后用【同一个二进制】校验并重载："
        info "  ${running_bin:-nginx} -t && ${running_bin:-nginx} -s reload"
        return 1
    fi

    if [ "$managed_by_systemd" = "0" ]; then
        # 装了 nginx 但没在跑（常见于 80 被 Docker 占着、宿主机 nginx 从没起来过）
        render_server_block > "$NGINX_CONF"
        nginx -t >/dev/null 2>&1 || { rm -f "$NGINX_CONF"; warn "配置校验失败"; return 1; }
        ok "配置已写入 ${NGINX_CONF}（只监听 ${PORT}）"

        local conflict
        conflict="$(grep -rn --include='*.conf' -E 'listen[[:space:]]+[^;]*\b80\b' /etc/nginx 2>/dev/null | head -3 || true)"
        if [ -n "$conflict" ]; then
            printf '\n'
            warn "配置里还有监听 80 的地方，一启动就会和占用 80 的进程冲突："
            printf '%s\n' "$conflict" | sed 's/^/      /'
            info "80 现在被谁占着：$(ss -lntp 2>/dev/null | grep ':80 ' | head -1 || echo '（查不到）')"
        fi

        if [ "$NGINX_START" = "1" ] && [ -z "$conflict" ]; then
            systemctl enable --now nginx 2>/dev/null && ok "已启动 nginx（只监听 ${PORT}）" \
                || warn "启动失败，请手工执行：systemctl enable --now nginx"
        else
            printf '\n'
            info "【没有动你的 nginx】配置写好了但没启动。要启动请加 NGINX_START=1 重跑。"
            return 1
        fi
        return 0
    fi

    # nginx 由 systemd 管且正在运行：只新增一个 8088 的 server，不动其他配置
    local backup=""
    if [ -f "$NGINX_CONF" ]; then
        backup="${NGINX_CONF}.bak.$(date +%Y%m%d%H%M%S)"
        cp -a "$NGINX_CONF" "$backup"
        info "已备份原配置到 ${backup}"
    fi
    render_server_block > "$NGINX_CONF"

    if ! nginx -t >/dev/null 2>&1; then
        printf '\n'
        nginx -t || true
        rm -f "$NGINX_CONF"
        [ -n "$backup" ] && cp -a "$backup" "$NGINX_CONF"
        warn "配置校验失败，已回滚"
        return 1
    fi
    ok "配置校验通过（只新增 ${PORT} 监听，不改动其他 server）"

    if systemctl reload nginx 2>/dev/null; then
        ok "已 reload nginx"
    else
        warn "reload 失败，请手工执行：systemctl reload nginx"
        return 1
    fi
    return 0
}

# ── 启用 COS 时先生成 302 跳转配置（容器要挂它）──────────
conf_changed=0
if [ "$USE_COS" = "1" ]; then
    mkdir -p "$(dirname "$COS_CONF_FILE")"
    NEW_CONF="$(mktemp)"
    cat > "$NEW_CONF" <<EOF
# 由 scripts/deploy-server.sh 生成，请勿手工修改（重跑脚本会覆盖）
#
# 这个 server 只做一件事：把更新产物的请求 302 跳转到 COS。
#
# 为什么这么做：更新服务器在境外，实测跨境链路只有几 KB/s ~ 几百 KB/s，
# 客户端在国内根本下不动 115 MB 的安装包。改成跳转后，
# 实际字节由 COS 直出（国内 MB/s 级），这台机器只剩几百字节的跳转发开销。
#
# 客户端会跟随 302（electron-updater 的 maxRedirects = 10），
# 所以**不需要重新打包客户端** —— 更新源地址仍然指向这台机器即可。
server {
    listen 80;
    server_name _;

    # latest.yml 必须每次拿最新的，不能被任何一层缓存住
    location = /latest.yml {
        add_header Cache-Control "no-store" always;
        return 302 ${COS_ORIGIN}${COS_PATH_PREFIX}/latest.yml;
    }

    # 安装包与 blockmap 原样跳到 COS。
    # 用 \$uri 而不是 \$request_uri：丢掉查询串
    # （electron-updater 会加 ?noCache=xxx），免得把未知参数透传给 COS。
    location ~ ^/(RPA_Pilot-[^/]+\.exe|RPA_Pilot-[^/]+\.exe\.blockmap)\$ {
        return 302 ${COS_ORIGIN}${COS_PATH_PREFIX}\$uri;
    }

    # 其它一律 404，避免把目录里的别的东西暴露出去
    location / {
        return 404;
    }
}
EOF
    if [ -f "$COS_CONF_FILE" ] && cmp -s "$NEW_CONF" "$COS_CONF_FILE"; then
        rm -f "$NEW_CONF"
        info "302 跳转配置无变化：${COS_CONF_FILE}"
    else
        mv "$NEW_CONF" "$COS_CONF_FILE"
        chmod 644 "$COS_CONF_FILE"
        conf_changed=1
        ok "已生成 302 跳转配置：${COS_CONF_FILE}"
        info "  跳转目标：${COS_ORIGIN}${COS_PATH_PREFIX}/"
    fi
fi

case "$SERVE_MODE" in
    docker)
        setup_docker_serving || die "Docker 方式部署失败（细节见上）。可以改用 SERVE_MODE=nginx"
        ;;
    nginx)
        setup_nginx_serving || warn "Nginx 方式未完成（细节见上）"
        ;;
    none)
        warn "SERVE_MODE=none，跳过 HTTP 服务配置"
        ;;
    auto)
        if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
            info "检测到 docker 可用 → 用独立容器提供服务（不碰宿主机 nginx）"
            setup_docker_serving || {
                warn "容器方式失败，回退到宿主机 nginx 方式"
                setup_nginx_serving || warn "两种方式都没成功，请手工处理（细节见上）"
            }
        else
            info "没有可用的 docker → 用宿主机 nginx 方式"
            setup_nginx_serving || warn "Nginx 方式未完成（细节见上）"
        fi
        ;;
    *)
        die "SERVE_MODE 只能是 docker / nginx / none / auto，收到：${SERVE_MODE}"
        ;;
esac

# ── 4) 防火墙 ───────────────────────────────────────────
step "4/6 放行端口 ${PORT}"
if [ "$SKIP_FIREWALL" = "1" ]; then
    warn "SKIP_FIREWALL=1，跳过"
elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    firewall-cmd --permanent --add-port="${PORT}/tcp" >/dev/null
    firewall-cmd --reload >/dev/null
    ok "firewalld 已放行 ${PORT}/tcp"
elif command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -qi active; then
    ufw allow "${PORT}/tcp" >/dev/null
    ok "ufw 已放行 ${PORT}/tcp"
else
    warn "没检测到启用中的 firewalld 或 ufw，系统防火墙可能本来就没开"
fi
warn "别忘了云厂商的安全组！腾讯云控制台 → 安全组 → 放行 ${PORT} 入站，否则本机 curl 通、外面连不上"

# ── 5) 自动拉取（cron）──────────────────────────────────
# 默认【不装 cron】：由你自己手动执行 rpa-sync 拉取即可。
# 想要定时自动拉，加 ENABLE_CRON=1 重跑本脚本。
step "5/6 自动拉取"
if [ "$ENABLE_CRON" = "1" ]; then
    CRON_LINE="${CRON_SCHEDULE} REPO=${REPO} TARGET_DIR=${TARGET_DIR} KEEP=${KEEP} OWNER=${WEB_USER} LOG_FILE=${LOG_FILE} ${BIN_PATH}"
    EXISTING="$(crontab -l 2>/dev/null || true)"

    if printf '%s\n' "$EXISTING" | grep -Fq "${BIN_PATH}"; then
        printf '%s\n' "$EXISTING" | grep -Fv "${BIN_PATH}" > /tmp/.rpa-cron.$$ || true
        printf '%s\n' "$CRON_LINE" >> /tmp/.rpa-cron.$$
        crontab /tmp/.rpa-cron.$$
        rm -f /tmp/.rpa-cron.$$
        ok "已更新已有的 cron 条目（${CRON_SCHEDULE}）"
    else
        { printf '%s\n' "$EXISTING"; printf '%s\n' "$CRON_LINE"; } | grep -v '^$' | crontab -
        ok "已添加 cron 条目（${CRON_SCHEDULE}）"
    fi
    info "当前 crontab："
    crontab -l 2>/dev/null | sed 's/^/      /'
else
    # 默认行为：把本脚本以前装的那条 cron 清掉，避免它继续偷偷在后台跑
    EXISTING="$(crontab -l 2>/dev/null || true)"
    if printf '%s\n' "$EXISTING" | grep -Fq "${BIN_PATH}"; then
        printf '%s\n' "$EXISTING" | grep -Fv "${BIN_PATH}" | grep -v '^$' > /tmp/.rpa-cron.$$ || true
        if [ -s /tmp/.rpa-cron.$$ ]; then
            crontab /tmp/.rpa-cron.$$
        else
            crontab -r 2>/dev/null || true
        fi
        rm -f /tmp/.rpa-cron.$$
        ok "已移除之前装的 cron 条目（改由你手动执行）"
    else
        info "没有装 cron（按你的要求：手动执行）"
    fi
    info "以后拉最新更新包，执行这一条："
    info "  sudo ${WRAPPER_PATH}"
    info "（想看历史日志：tail -f ${LOG_FILE}）"
fi

# ── 6) 连通性验证 ───────────────────────────────────────
step "6/6 验证能否连上 GitHub"
if [ "$SKIP_CHECK" = "1" ]; then
    warn "SKIP_CHECK=1，跳过"
else
    if "$BIN_PATH" --target "$TARGET_DIR" --check; then
        ok "能读到 GitHub 上的版本信息"
    else
        warn "读取失败 —— 检查服务器能否访问 github.com（公司网络/代理可能拦）"
    fi
fi

# ── 汇总 ────────────────────────────────────────────────
printf '\n\033[1;32m部署完成\033[0m\n\n'
if [ "$USE_COS" = "1" ]; then
cat <<EOF
日常就一条命令（没有装 cron，完全由你手动控制）：

  拉取最新版并上传到 COS：  sudo ${WRAPPER_PATH}
  只看远端版本：            sudo ${WRAPPER_PATH} --check
  强制重下：                sudo ${WRAPPER_PATH} --force

验证（关键：确认 302 真的跳到 COS）：

  # 1) 本机应当返回 302 且 Location 指向 COS
  curl -sI http://127.0.0.1:${PORT}/latest.yml | grep -iE 'HTTP/|location'

  # 2) 跟随后应真的拿到 latest.yml（内容来自 COS）
  curl -sL http://127.0.0.1:${PORT}/latest.yml | head -3

  # 3) 安装包也要 302（-I 不下载，只跳转，很快）
  curl -sI http://<公网IP>:${PORT}/RPA_Pilot-<版本>-setup.exe | grep -iE 'HTTP/|location'

  # 4) 绕开服务器，直连 COS 测速度（用来确认桶权限是公有读）
  curl -sI ${COS_ORIGIN}${COS_PATH_PREFIX}/latest.yml | head -1

  # 5) 不该被访问到的路径仍然要 404
  curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:${PORT}/package.json

注意：
  · 客户端不需要重新打包 —— 302 会被 electron-updater 跟随（maxRedirects = 10），
    更新源地址继续用这台机器的 ${PORT} 端口即可。
  · 顺序由脚本保证：先传安装包和 blockmap，最后传 latest.yml，
    避免客户端读到指向「还没传完的安装包」的版本清单。
  · 客户端连不上 COS 时更新会失败。本机目录里仍然保留着完整产物，
    应急时可以把 ${COS_CONF_FILE} 删掉并重跑本脚本（不带 COS_BUCKET），退回本机直供。

COS 桶：${COS_BUCKET}（${COS_REGION}）  跳转配置：${COS_CONF_FILE}  coscli 配置：${COS_CLI_CONFIG}
同步日志：${LOG_FILE}
改端口/目录后重跑本脚本即可，它是幂等的。
EOF
else
cat <<EOF
日常就一条命令（没有装 cron，完全由你手动控制）：

  拉取最新更新包：   sudo ${WRAPPER_PATH}
  只看远端版本：     sudo ${WRAPPER_PATH} --check
  强制重下：         sudo ${WRAPPER_PATH} --force

验证：
  curl -I http://127.0.0.1:${PORT}/latest.yml      # 应 200
  curl -I http://127.0.0.1:${PORT}/package.json    # 应 404
  curl -I http://<公网IP>:${PORT}/latest.yml        # 外面也要通（安全组）

检查服务器上的安装包与 latest.yml 声明的 sha512 是否一致：
  cd ${TARGET_DIR}
  grep -m1 '^sha512:' latest.yml
  sha512sum RPA_Pilot-*-setup.exe | awk '{print \$1}' | xxd -r -p | base64 -w0; echo

同步日志：${LOG_FILE}
改端口/目录后重跑本脚本即可，它是幂等的。
想让服务器每 15 分钟自动拉一次：sudo ENABLE_CRON=1 bash scripts/deploy-server.sh

【重要】这台机器跨境带宽实测只有几 KB/s ~ 几百 KB/s，客户端下载 115 MB
可能要几十分钟甚至几小时，且关掉应用就得从头再来。建议改用 COS：
  COS_BUCKET=xxx COS_REGION=ap-guangzhou COS_SECRET_ID=xxx COS_SECRET_KEY=xxx \\
    sudo -E bash scripts/deploy-server.sh

注意：更新目录的写权限要保持只有 root 可写。
不签名的话，谁能写这个目录，谁就能给所有客户端推任意代码。
EOF
fi
