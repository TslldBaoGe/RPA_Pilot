#!/usr/bin/env bash
#
# RPA_Pilot 更新服务器一键部署（Linux）。
#
# 用法（在仓库里执行，可反复运行，幂等）：
#     git pull
#     sudo bash scripts/deploy-server.sh
#
# 它会做完这些事：
#   1. 建更新目录并设好属主/权限
#   2. 装拉取脚本到 /usr/local/bin
#   3. 写好 Nginx 配置并 reload（配置有备份，校验失败会自动回滚）
#   4. 放行端口（自动识别 firewalld / ufw）
#   5. 注册 cron（已存在则不重复添加）
#   6. 跑一次 --check 验证能连上 GitHub
#
# 可用环境变量覆盖默认值：
#   REPO=owner/repo TARGET_DIR=/swagtslld/RPA_Pilot PORT=8088 SERVER_NAME=_ KEEP=3
#   WEB_USER=nginx LOG_FILE=/var/log/rpa-pilot-sync.log
#   SKIP_NGINX=1 SKIP_FIREWALL=1 SKIP_CRON=1 SKIP_CHECK=1
#
set -euo pipefail

# ── 默认配置 ────────────────────────────────────────────
REPO="${REPO:-TslldBaoGe/RPA_Pilot}"

# 更新目录 = Nginx 的默认站点根目录。
# 各发行版不一样（RHEL/CentOS 是 /usr/share/nginx/html，Debian/Ubuntu 是 /var/www/html），
# 所以这里在目标机器上探测，而不是写死一个。
detect_default_webroot() {
    # 1) 优先看 nginx.conf 主配置里 server 块写的 root
    if [ -f /etc/nginx/nginx.conf ]; then
        local fromconf
        fromconf="$(awk '/^[[:space:]]*root[[:space:]]/{print $2}' /etc/nginx/nginx.conf 2>/dev/null | head -1 | tr -d ';')"
        if [ -n "$fromconf" ] && [ -d "$fromconf" ]; then
            echo "$fromconf"
            return
        fi
    fi
    # 2) 退回到各发行版的约定目录
    for candidate in /usr/share/nginx/html /var/www/html /var/www; do
        if [ -d "$candidate" ]; then
            echo "$candidate"
            return
        fi
    done
    # 3) 都没有就用 RHEL 系的约定路径
    echo /usr/share/nginx/html
}

TARGET_DIR="${TARGET_DIR:-$(detect_default_webroot)}"
PORT="${PORT:-8088}"
SERVER_NAME="${SERVER_NAME:-_}"          # _ = 该端口上通配（这个端口专供本项目）
KEEP="${KEEP:-3}"
LOG_FILE="${LOG_FILE:-/var/log/rpa-pilot-sync.log}"
NGINX_CONF="${NGINX_CONF:-/etc/nginx/conf.d/rpa-pilot.conf}"
BIN_PATH="${BIN_PATH:-/usr/local/bin/sync-updates.sh}"
CRON_SCHEDULE="${CRON_SCHEDULE:-*/15 * * * *}"

SKIP_NGINX="${SKIP_NGINX:-0}"
SKIP_FIREWALL="${SKIP_FIREWALL:-0}"
SKIP_CRON="${SKIP_CRON:-0}"
SKIP_CHECK="${SKIP_CHECK:-0}"
# 默认【不启动、不修改】宿主机 nginx。
# 很多机器上 80 端口属于另一个项目（常见是跑在 Docker 里），
# 随意 enable/start 宿主机 nginx 会和它抢端口。需要时显式设 1。
NGINX_START="${NGINX_START:-0}"

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
SYNC_SRC="${SCRIPT_DIR}/sync-updates.sh"

# 正常情况下本脚本和 sync-updates.sh 都在 <仓库>/scripts/ 下。
# 但如果只把本脚本单独拷到服务器上跑，就从 GitHub 兜底拉一份（公开仓库，不需要 Token）。
if [ ! -f "$SYNC_SRC" ]; then
    warn "同目录下没找到 sync-updates.sh，尝试从 GitHub 拉取"
    SYNC_SRC="/tmp/sync-updates.sh.$$"
    curl -fsSL -o "$SYNC_SRC" "https://raw.githubusercontent.com/${REPO}/main/scripts/sync-updates.sh" \
        || die "拉取失败。请确认在仓库目录里执行（git pull 后再跑），或服务器能访问 github.com"
    ok "已从 GitHub 获取 sync-updates.sh"
fi

# 自动识别 Web 服务账号：不同发行版不一样，写错会导致 Nginx 读不到文件
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
info "更新目录  : ${TARGET_DIR}"
info "监听端口  : ${PORT}"
info "Web 账号  : ${WEB_USER}"

# ── 1) 更新目录 ─────────────────────────────────────────
step "1/6 准备更新目录"
if [ -d "$TARGET_DIR" ]; then
    # 目录已存在就**不要**改它的属主和权限 —— 那很可能是你已有站点的根目录，
    # chown 一下可能把整个站点的属主都改掉。
    info "${TARGET_DIR} 已存在，不改动属主与权限"
    info "当前：$(stat -c '%A %U:%G' "$TARGET_DIR" 2>/dev/null || echo '无法读取')"
    CREATED=0
else
    mkdir -p "$TARGET_DIR"
    chown "${WEB_USER}:${WEB_USER}" "$TARGET_DIR" 2>/dev/null || warn "chown ${WEB_USER} 失败，请手工确认"
    chmod 755 "$TARGET_DIR"
    ok "已创建 ${TARGET_DIR}（属主 ${WEB_USER}，权限 755）"
    CREATED=1
fi

# ── 2) 安装拉取脚本 ─────────────────────────────────────
step "2/6 安装拉取脚本"
install -m 0755 "$SYNC_SRC" "$BIN_PATH"
ok "${BIN_PATH}"
# 顺带确认脚本语法没问题（部署出错时能早发现）
bash -n "$BIN_PATH" || die "拉取脚本语法检查失败"
ok "语法检查通过"

# ── 3) Nginx 配置 ───────────────────────────────────────
step "3/6 配置 Nginx"

# 生成 server 块：只放行更新产物，其余一律 404。
# 这样即使更新目录里同时放着别的东西（源码 / .git / package.json），也不会暴露到公网。
render_server_block() {
    cat <<EOF
# 由 scripts/deploy-server.sh 生成，请勿手工修改（会被覆盖）
server {
    listen ${PORT};
    server_name ${SERVER_NAME};

    root ${TARGET_DIR};
    autoindex off;

    # 只允许这三个东西：latest.yml、安装包、差量索引
    location ~ ^/(latest\.yml|RPA_Pilot-[^/]+\.exe|RPA_Pilot-[^/]+\.exe\.blockmap)\$ {
        try_files \$uri =404;
        # latest.yml 是更新入口，绝不能被缓存，否则客户端看不到新版本
        add_header Cache-Control "no-store" always;
    }

    # 其余路径一律 404（源码、.git、package.json 等都不可访问）
    location / {
        return 404;
    }
}
EOF
}

# 探测 nginx 到底是谁在管 —— 这一步非常关键，写错会弄坏用户已有的站点：
#   情况 A：nginx 由 systemd 管 → 写 /etc/nginx/conf.d/ 然后 systemctl reload
#   情况 B：nginx 由宝塔面板 / 1Panel / Docker / 手工启动 → systemctl 管不到它，
#          而且它的配置目录也不是 /etc/nginx/conf.d。盲写文件不会生效，
#          还可能让「多余的第二个 nginx」启动失败（就是 80 端口冲突那个报错）。
NGINX_MANAGED_BY_SYSTEMD=0
NGINX_RUNNING_PID=""
NGINX_RUNNING_BIN=""

if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet nginx 2>/dev/null; then
    NGINX_MANAGED_BY_SYSTEMD=1
fi

if [ "$NGINX_MANAGED_BY_SYSTEMD" = "0" ] && command -v pgrep >/dev/null 2>&1; then
    NGINX_RUNNING_PID="$(pgrep -f 'nginx: master process' 2>/dev/null | head -1 || true)"
    [ -n "$NGINX_RUNNING_PID" ] || NGINX_RUNNING_PID="$(pgrep -x nginx 2>/dev/null | head -1 || true)"
    if [ -n "$NGINX_RUNNING_PID" ]; then
        NGINX_RUNNING_BIN="$(readlink -f "/proc/${NGINX_RUNNING_PID}/exe" 2>/dev/null || true)"
    fi
fi

if [ "$SKIP_NGINX" = "1" ]; then
    warn "SKIP_NGINX=1，跳过"
elif [ "$NGINX_MANAGED_BY_SYSTEMD" = "0" ] && [ -n "$NGINX_RUNNING_PID" ]; then
    printf '\n'
    warn "检测到一个正在运行的 nginx，但它不归 systemd 管："
    info "  PID    : ${NGINX_RUNNING_PID}"
    info "  二进制 : ${NGINX_RUNNING_BIN:-（读不到，可能是容器内的进程）}"
    info "  systemd: $(systemctl is-active nginx 2>/dev/null || echo unknown)"
    printf '\n'
    warn "所以 /etc/nginx/conf.d/ 多半不是它的配置目录，systemctl reload nginx 也管不到它。"
    warn "【已主动跳过 Nginx 配置】—— 盲写文件不会生效，还可能弄坏你现有的站点。"
    printf '\n'
    info "请手工把下面这段加到那个 nginx 的配置里。先确认它的配置目录："
    info "  ${NGINX_RUNNING_BIN:-nginx} -V 2>&1 | tr ' ' '\\n' | grep -E 'conf-path|prefix'"
    info "宝塔面板通常是 /www/server/panel/vhost/nginx/*.conf；1Panel 在 /opt/1panel/... 下"
    printf '\n'
    render_server_block | sed 's/^/      /'
    printf '\n'
    info "加完用【同一个二进制】校验并重载（不要用 systemctl）："
    info "  ${NGINX_RUNNING_BIN:-nginx} -t && ${NGINX_RUNNING_BIN:-nginx} -s reload"
    printf '\n'
elif ! command -v nginx >/dev/null 2>&1; then
    warn "系统里没有 nginx，跳过。装好后重跑本脚本即可"
elif [ "$NGINX_MANAGED_BY_SYSTEMD" = "0" ]; then
    # 到这里说明：装了 nginx、systemd 有它的 unit，但当前没有 host nginx 在跑。
    # 常见于「80 端口被 Docker 容器占着，宿主机 nginx 从没起来过」。
    # 此时不能盲目 start —— 发行版默认站点里有 listen 80，一启动就会和 Docker 撞车。
    BACKUP=""
    if [ -f "$NGINX_CONF" ]; then
        BACKUP="${NGINX_CONF}.bak.$(date +%Y%m%d%H%M%S)"
        cp -a "$NGINX_CONF" "$BACKUP"
        info "已备份原配置到 ${BACKUP}"
    fi
    render_server_block > "$NGINX_CONF"

    if ! nginx -t >/dev/null 2>&1; then
        printf '\n'
        nginx -t || true
        rm -f "$NGINX_CONF"
        [ -n "$BACKUP" ] && cp -a "$BACKUP" "$NGINX_CONF"
        die "Nginx 配置校验失败，已回滚。请检查上面的报错"
    fi
    ok "配置已写入 ${NGINX_CONF}（只监听 ${PORT}）"

    # 关键检查：nginx 配置树里还有没有别的 listen 80？
    # 有的话一启动就会撞上已经占用 80 的进程（很可能是 docker-proxy），
    # 报 address already in use —— 所以我们先不启动，把解法给出来。
    CONFLICT="$(grep -rn --include='*.conf' -E 'listen[[:space:]]+[^;]*\b80\b' /etc/nginx 2>/dev/null | head -5 || true)"

    if [ -n "$CONFLICT" ]; then
        printf '\n'
        warn "Nginx 配置里还存在监听 80 的地方，启动它必然和已占用 80 的进程冲突："
        printf '%s\n' "$CONFLICT" | sed 's/^/      /'
        printf '\n'
        info "80 现在被谁占着：$(ss -lntp 2>/dev/null | grep ':80 ' | head -1 || echo '（查不到）')"
    fi

    # 默认**不启动、不修改任何 nginx**。
    # 很多机器上 80 端口属于另一个项目（常见是跑在 Docker 里），
    # 随意 enable/start 宿主机 nginx 会和它抢端口，或者让用户以为网站出问题了。
    # 只有显式 NGINX_START=1 才去启动。
    if [ "$NGINX_START" = "1" ] && [ -z "$CONFLICT" ]; then
        if systemctl enable --now nginx 2>/dev/null; then
            ok "已启动 nginx 并设为开机自启（只监听 ${PORT}）"
        else
            warn "启动失败，请手工执行：systemctl enable --now nginx"
        fi
    else
        printf '\n'
        info "【没有动你的 nginx】配置已写入 ${NGINX_CONF}（只监听 ${PORT}），但没有启动它。"
        printf '\n'
        info "如果 80 端口上的站点属于别的项目（尤其是跑在 Docker 里的），推荐用独立容器喂 ${PORT}，"
        info "这样和现有网站完全隔离、互不影响："
        printf '\n'
        cat <<DOCKER | sed 's/^/      /'
docker run -d --name rpa-pilot-updates --restart unless-stopped \
  -p PORT_MAP \
  -v TARGET_MAP:/usr/share/nginx/html:ro \
  nginx:alpine
DOCKER
        printf '\n'
        info "（把 PORT_MAP 换成 ${PORT}:80，TARGET_MAP 换成 ${TARGET_DIR}）"
        printf '\n'
        info "或者，如果你确认宿主机 nginx 就是给这个更新服务用的、不会和 80 上的项目冲突，"
        info "可以重新跑本脚本并加上 NGINX_START=1："
        info "  sudo NGINX_START=1 bash scripts/deploy-server.sh"
        if [ -n "$CONFLICT" ]; then
            printf '\n'
            warn "但上面那个 listen 80 的冲突必须先解决（去掉发行版默认站点）："
            info "  rm -f /etc/nginx/sites-enabled/default"
        fi
    fi

    # shellcheck disable=SC2012
    ls -1t "${NGINX_CONF}".bak.* 2>/dev/null | tail -n +6 | while read -r f; do rm -f "$f"; done || true
else
    BACKUP=""
    if [ -f "$NGINX_CONF" ]; then
        BACKUP="${NGINX_CONF}.bak.$(date +%Y%m%d%H%M%S)"
        cp -a "$NGINX_CONF" "$BACKUP"
        info "已备份原配置到 ${BACKUP}"
    fi

    render_server_block > "$NGINX_CONF"

    if ! nginx -t >/dev/null 2>&1; then
        printf '\n'
        nginx -t || true
        rm -f "$NGINX_CONF"
        if [ -n "$BACKUP" ]; then
            cp -a "$BACKUP" "$NGINX_CONF"
            die "Nginx 配置校验失败，已回滚到原配置。请检查上面的报错"
        fi
        die "Nginx 配置校验失败，已删除生成的配置。请检查上面的报错"
    fi
    ok "配置校验通过"

    if systemctl reload nginx 2>/dev/null; then
        ok "已 reload nginx"
    elif command -v nginx >/dev/null 2>&1 && nginx -s reload 2>/dev/null; then
        ok "已 reload nginx（nginx -s reload）"
    else
        warn "reload 失败，请手工执行：systemctl reload nginx 或 nginx -s reload"
    fi

    # 备份太多也没意义，只留最近 5 份
    # shellcheck disable=SC2012
    ls -1t "${NGINX_CONF}".bak.* 2>/dev/null | tail -n +6 | while read -r f; do rm -f "$f"; done || true
fi

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

# ── 5) cron ─────────────────────────────────────────────
step "5/6 注册 cron（${CRON_SCHEDULE}）"
if [ "$SKIP_CRON" = "1" ]; then
    warn "SKIP_CRON=1，跳过"
else
    CRON_LINE="${CRON_SCHEDULE} REPO=${REPO} TARGET_DIR=${TARGET_DIR} KEEP=${KEEP} OWNER=${WEB_USER} LOG_FILE=${LOG_FILE} ${BIN_PATH}"
    EXISTING="$(crontab -l 2>/dev/null || true)"

    if printf '%s\n' "$EXISTING" | grep -Fq "${BIN_PATH}"; then
        # 已经有了：先删掉旧的同类行再写新的，这样改了参数重跑也能生效
        printf '%s\n' "$EXISTING" | grep -Fv "${BIN_PATH}" > /tmp/.rpa-cron.$$ || true
        printf '%s\n' "$CRON_LINE" >> /tmp/.rpa-cron.$$
        crontab /tmp/.rpa-cron.$$
        rm -f /tmp/.rpa-cron.$$
        ok "已更新已有的 cron 条目"
    else
        { printf '%s\n' "$EXISTING"; printf '%s\n' "$CRON_LINE"; } | grep -v '^$' | crontab -
        ok "已添加 cron 条目"
    fi
    info "当前 crontab："
    crontab -l 2>/dev/null | sed 's/^/      /'
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
cat <<EOF
接下来做两件事：

  1) 立刻同步一次（把安装包拉到本地，约 115 MB）
       sudo ${BIN_PATH} --target ${TARGET_DIR} --owner ${WEB_USER}

  2) 验证对外可访问
       curl -I http://<你的公网IP>:${PORT}/latest.yml      # 应返回 200
       curl -I http://<你的公网IP>:${PORT}/package.json    # 应返回 404（源码不可访问）

  同步日志：${LOG_FILE}      也可看：journalctl -u cron
  改端口/目录后重跑本脚本即可，它是幂等的。

注意：更新目录的写权限要保持只有 root 可写。
不签名的话，谁能写这个目录，谁就能给所有客户端推任意代码。
EOF
