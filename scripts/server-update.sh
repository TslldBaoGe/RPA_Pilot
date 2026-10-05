#!/usr/bin/env bash
#
# 服务器上的一站式更新入口 —— 每次 git pull 之后，跑这一条就够了。
#
#     cd /path/to/RPA_Pilot
#     git pull
#     sudo bash scripts/server-update.sh
#
# 它依次做两件事，两步都是幂等的：
#   1) scripts/deploy-server.sh —— 把仓库里的脚本/配置改动应用到系统上：
#      重装 sync-updates.sh、重新生成 rpa-sync、按需重建提供服务的容器（或 nginx）。
#      没变化时基本不花时间。
#   2) rpa-sync —— 拉取 GitHub 上最新的发行版，写进更新目录；版本没变会自动跳过。
#
# 参数会原样传给 rpa-sync，例如：
#     sudo bash scripts/server-update.sh --force    # 版本相同也重下（修复损坏的产物）
#     sudo bash scripts/server-update.sh --check    # 只看远端是什么版本，不下载
#
# 部署部分没变、只想同步（可省几秒）：
#     sudo SKIP_DEPLOY=1 bash scripts/server-update.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WRAPPER_PATH="${WRAPPER_PATH:-/usr/local/bin/rpa-sync}"

[ "$(id -u)" -eq 0 ] || { echo "需要 root 权限，请用：sudo bash scripts/server-update.sh" >&2; exit 1; }

if [ "${SKIP_DEPLOY:-0}" != "1" ]; then
    bash "${SCRIPT_DIR}/deploy-server.sh"
fi

if [ ! -x "$WRAPPER_PATH" ]; then
    echo "找不到 ${WRAPPER_PATH}，请先执行一次：sudo bash scripts/deploy-server.sh" >&2
    exit 1
fi

# 交给 rpa-sync 完成真正的拉取（它内部已经带好更新目录、属主、保留份数）
exec "$WRAPPER_PATH" "$@"
