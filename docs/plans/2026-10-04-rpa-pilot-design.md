# RPA_Pilot 本地 Python 任务管理客户端 — 设计文档

- 日期：2026-10-04
- 状态：待确认（含 3 处默认假设，见第 10 节）
- 形态：Windows 桌面应用，托盘常驻

> ## ⚠️ 重要修订记录
>
> **修订 1（2026-10-04，M2 之后）：推翻约束 C1 与 C2**
>
> 原方案要求「所有文件都在项目内」+「不调用外部 Miniconda」，为此把一份 Miniconda
> 装进了 `D:\RPA_Pilot\runtime\`，并把 pnpm 全局缓存重定向进项目。
> 实测结果：**项目膨胀到 3.95 GB**（runtime 1.45 GB + .pnpm-store 1.58 GB + node_modules 0.64 GB
> + .cache 0.28 GB），被明确否决。
>
> 现行方案：
> 1. **Miniconda 位置由用户指定**，程序自动探测（优先读 `~/.conda/environments.txt`）或让用户手选目录；
>    项目内**不再安装任何 Python 运行时**。
> 2. pnpm 缓存与 Electron 缓存**回归各自默认的全局位置**。
> 3. 项目体积回到 **643 MB**（其中 node_modules 640 MB 是 Electron 框架本身的代价，删不掉）。
>
> 被推翻的旧结论（保留在本文件里作为历史，但**不要再照做**）：
> 第 2 节旧 C1/C2、第 5 节旧目录规划（含 runtime/）、第 7.1 节首启安装向导、
> 第 11 节部分坑表、第 13 节全部内容（安装 Miniconda 的整套实现已删除）。
>
> **修订 2（2026-10-05，M7 之后）：任务可以引用工作目录之外的 .py**
>
> 原方案规定「脚本必须位于 `tasks\` 内」，任务只能来自扫描。实际使用中这不够用：
> 业务脚本常常已经在别的地方（本机其他盘、网络共享盘）由别人维护，
> 强迫用户把文件搬进工作目录既啰嗦、又会让「改源文件不生效」变成新坑。
>
> 现行做法（详见第 21 节）：
> 1. 新建/编辑任务时可以**自己指定 .py 路径**：相对 `tasks\`、本地绝对路径、UNC 网络共享都可以。
> 2. **原地引用，不复制**。落在 `tasks\` 内的仍存相对路径，工作目录之外的一律存绝对路径。
> 3. 路径解析统一走 `resolveScriptPath()`；任何判断「脚本还在不在」的地方都必须用它。
> 4. 扫描 `tasks\` 依然是「零配置发现脚本」的入口，两者并存互不影响。
>
> 这一条推翻了第 7.3 节里「不允许任务引用 tasks\ 之外的外部脚本路径」的旧结论。


---

## 1. 目标与非目标

### 目标

给公司业务同事一个本地桌面客户端，用来管理和运行 Python 脚本任务：

1. **任务用中文名标识** —— 业务同事看到的是「每日销售报表」，不是 `daily_report.py`。
2. **中文名映射到 .py 文件** —— 一个任务 = 一个中文名 + 一个 py 脚本 + 一个 Python 环境。
3. **定时运行** —— 按 cron 表达式触发，配置持久化，重启后自动恢复。
4. **立即执行** —— 一键运行，实时看日志输出。
5. **环境自包含** —— Python 版本由 Miniconda 管理，且 Miniconda 与所有 env 都放在项目目录内。

### 非目标（YAGNI，本期明确不做）

- 多用户 / 账号 / 权限体系
- 分布式执行、远程节点、任务队列集群
- DAG 编排（任务依赖图）、工作流设计器
- 任务脚本的可视化编排 / 低代码搭建
- 跨平台（本期只做 Windows）

---

## 2. 约束（含修订）

### 现行有效约束

| 编号 | 约束 | 落实方式 |
|---|---|---|
| C1 | **项目目录保持精简**（不再要求「所有文件都在项目内」） | 项目只放源码、任务脚本、数据库、日志与构建产物；pnpm 缓存与 Electron 缓存走各自默认的全局位置 |
| C2 | **Miniconda 位置由用户指定**，本机已有则直接复用 | 自动探测（`~/.conda/environments.txt` → PATH → 常见位置 → 各盘符扫描）；用户可在界面手选并保存 |
| C3 | Python 版本经 Miniconda 管理 | 任务绑定该 Miniconda 下的某个 env；不在项目内另装一套 |
| C4 | 项目内**不安装** Python 运行时 | 安装 Miniconda 的整套代码已删除（见修订记录） |

### 已作废的旧约束（历史，勿照做）

| 编号 | 旧约束 | 为什么作废 |
|---|---|---|
| ~~C1~~ | 所有新文件只落在 `D:\RPA_Pilot` 内 | 为了做到这一点把 pnpm store 重定向进项目，单项就多占 1.58 GB；代价远大于收益 |
| ~~C2~~ | 不调用外部 Miniconda 环境 | 为做到这一点在项目内装了一份 Miniconda，多占 1.45 GB；而本机已有的 `F:\Miniconda39` 有 12 个可用环境（Python 3.5.4 ~ 3.12.12），完全够用 |
| ~~C4~~ | 首次启动由用户指定本地安装包 | 被「直接指定已有 Miniconda 目录」取代，更简单且不产生新的磁盘占用 |

> 教训：**「自包含」在桌面客户端上是有成本的**，而这个成本（约 3 GB）最终由使用者承担。
> 除非有明确的隔离需求（例如要交付给没有 Python 环境的机器），否则复用本机已有环境更划算。


---

## 3. 技术栈

版本为 2026-10-04 实测 registry 最新版。

| 层 | 选型 | 版本 | 说明 |
|---|---|---|---|
| 桌面框架 | **Electron** | 44.5.1 | 自带 Node，最终用户无需装 Node |
| 构建 | **electron-vite** | 5.0.0 | 主进程 / preload / 渲染进程三份独立构建配置 |
| 前端 | **Vue 3** + **Element Plus** | 3.5.43 / 2.14.7 | `el-table-v2` 虚拟滚动扛日志与运行记录 |
| 语言 | **TypeScript** | 7.0.2 | 若与工具链有兼容问题则回退 5.x |
| 状态 | **Pinia** + **Vue Router** | 4.0.3 / 5.3.1 | |
| 打包 | **Vite** + `@vitejs/plugin-vue` | 7.3.6 / 6.0.9 | **必须锁 7.x**：electron-vite 5 的 peer 是 `^5\|\|^6\|\|^7`，装 Vite 8 会 unmet peer |
| 存储 | **better-sqlite3** | 13.0.3 | v13 已改用 **N-API**，且 npm 包内自带 `prebuilds/win32-x64.node`，**无需重编译**，二进制在 Node 与 Electron 间 ABI 通用 |
| 调度 | **croner** | 10.0.1 | 零依赖、支持时区、内置 `protect` 防重入 |
| 打包分发 | **electron-builder** | 26.15.3 | NSIS 安装包 + 便携版 |
| 日志 | **electron-log** | 5.4.4 | 主进程自身日志（与任务日志分开） |

**不选**：Python 后端 sidecar（FastAPI 等）。应用逻辑不需要 Python，任务本身才是 Python 进程；引入 sidecar 等于凭空多一条 IPC 边界和一套运行时。**不选** Celery / Airflow / Redis：单机场景纯属负担。

---

## 4. 架构

### 4.1 进程模型

```
┌─────────────────────────────────────────────────────┐
│ Electron 主进程 (Node) —— 唯一大脑                    │
│  DB(better-sqlite3) / 调度(croner) / 子进程管理        │
│  日志落盘 / 托盘 / 单实例锁                            │
└───────────┬─────────────────────────┬───────────────┘
            │ IPC(contextBridge)      │ child_process.spawn
            │ 调用 + 日志事件推送       │
┌───────────▼───────────┐   ┌─────────▼─────────────────┐
│ 渲染进程 (Vue3)        │   │ 任务子进程 × N             │
│ 纯 UI，无业务逻辑       │   │ runtime\...\envs\<e>\      │
│                       │   │   python.exe  tasks\xx.py  │
└───────────────────────┘   └───────────────────────────┘
```

只有一个 IPC 边界：`main ↔ renderer`。任务进程与 UI 之间不直接通信，全经主进程中转。

### 4.2 模块划分（为服务化预留口子）

```
src/main/
├─ core/                 ← 不 import electron，只用 Node 标准库
│   ├─ db.ts             schema、迁移、DAO
│   ├─ conda.ts          项目内 conda 定位、环境枚举、python.exe 解析
│   ├─ runner.ts         spawn、日志分流、超时、进程树杀
│   └─ scheduler.ts      croner 注册/恢复、重叠策略、错过补偿
├─ ipc/                  把 core 暴露给渲染进程（ipcMain.handle）
├─ tray.ts / window.ts / index.ts
```

`core/` 不依赖 electron 是**刻意的**：将来要把调度与执行搬进 Windows 服务（无人登录也能跑）时，只需换一个宿主进程和一层传输（HTTP / 命名管道），`core/` 代码零改动。这就是「先托盘版、架构上预留服务化」的落地方式。

---

## 5. 目录规划（修订后）

```
D:\RPA_Pilot\                     643 MB（其中 node_modules 640 MB）
├─ src\
│   ├─ main\      Electron 主进程（core\ 层刻意不依赖 electron）
│   │   └─ core\  paths / db / settings / conda / tasks / python-probe
│   ├─ preload\   contextBridge 安全桥
│   ├─ renderer\  Vue3 + Element Plus（router + views + components）
│   └─ shared\    主/渲染进程共享类型
├─ scripts\fetch-electron.mjs    ← 绕开 pnpm 的构建脚本门控，触发 Electron 二进制下载
├─ resources\icon.png            ← 托盘 / 打包图标
├─ tasks\                        ← 业务脚本，只扫这里
├─ data\app.db                   ← SQLite（WAL 模式）
├─ logs\<任务名>\<yyyyMMdd_HHmmss>.log
├─ out\                          ← electron-vite 构建产物
├─ .cache\tmp\                   ← 依赖清单临时文件（用完即删）
└─ docs\plans\
```

**不在项目内的东西（修订后）**

| 内容 | 位置 |
|---|---|
| Python 运行时 | 用户指定的 Miniconda，例如 `F:\Miniconda39` |
| pnpm 内容寻址缓存 | pnpm 默认的全局 store |
| Electron 二进制 / electron-builder 缓存 | 各自默认的全局位置 |

不提交 git：`node_modules/`、`data/`、`logs/`、`out/`、`.cache/`。`tasks/` 只保留示例脚本。

---

## 6. 数据模型

### Task

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | UUID，内部主键 |
| name | TEXT UNIQUE NOT NULL | **中文名称**，业务同事看到的标识，不允许重名 |
| script_path | TEXT NOT NULL | 脚本路径。`tasks\` 内的存相对路径；工作目录之外的存**绝对路径**（含 UNC），原地引用。统一用 `resolveScriptPath()` 解析（修订 2） |
| conda_env | TEXT NOT NULL | 项目内 env 名，如 `python3119` |
| cwd | TEXT | 工作目录，默认脚本所在目录 |
| args | TEXT(JSON) | 启动参数数组 |
| cron_expr | TEXT NULL | cron 表达式；NULL = 仅手动 |
| timezone | TEXT | 默认 `Asia/Shanghai` |
| timeout_sec | INTEGER | 0 = 不限 |
| overlap_policy | TEXT | `skip` / `queue` / `allow`，默认 `skip` |
| retry_times | INTEGER | 失败重试次数，默认 0 |
| notify_on_fail | INTEGER | 是否发通知 |
| enabled | INTEGER | 定时是否生效 |
| created_at / updated_at | TEXT | ISO8601 |

### Run

| 字段 | 说明 |
|---|---|
| id | UUID |
| task_id | FK → Task |
| trigger | `manual` / `schedule` |
| status | `queued` / `running` / `success` / `failed` / `timeout` / `killed` / `skipped` / `missed` |
| exit_code | 进程退出码 |
| pid | 进程 ID（用于强杀） |
| started_at / finished_at / duration_ms | 时间与耗时 |
| log_path | 日志文件路径 |
| error_summary | 失败摘要（stderr 尾部若干行） |

### Setting

`key / value`，存项目内 conda 根路径、日志保留天数、飞书 Webhook、开机自启等。

---

## 7. 关键流程

### 7.1 Miniconda 定位（修订：取代原「首次启动安装向导」）

1. 解析顺序（`core/conda.ts` 的 `resolveCondaDir`）：
   1. 用户保存过的设置（settings 表的 `condaDir`）→ 校验是否仍可用，失效则继续往下探
   2. `~/.conda/environments.txt` 的第一条可用路径（通常是 base 安装目录）
   3. 系统 PATH 里的 conda —— 由 `<base>\Scripts\conda.exe` 反推 base 目录
   4. 常见安装位置（`%USERPROFILE%\miniconda3` 等）+ 各盘符根目录下形如 `Miniconda*` / `Anaconda*` 的目录
2. 校验标准：目录下必须**同时**存在 `python.exe` 与 `Scripts\conda.exe`。
3. 界面上显示**位置来源**（「已保存的设置」/「conda 环境注册表 ~/.conda/environments.txt」/「系统 PATH 中的 conda」），
   让用户能判断这个自动探测结果是否可信 —— 自动探测最大的风险就是「悄悄用错了目录」。
4. 用户可随时「更改位置」（目录选择框）或「恢复自动探测」（清掉保存的设置）。
5. 环境列表 = `base` + `<condaDir>\envs\` 下所有含 `python.exe` 的直接子目录。
   刻意不用 `conda env list --json`：它慢，且会把别的 conda 安装的环境也混进来。

**关于 pip 镜像**：现状是 `createEnv` 默认注入清华 `PIP_INDEX_URL`，可在「新建环境」对话框里覆盖。
`EnvCreateOptions.pipIndexUrl` 已经预留了这个口子，但界面上还没接输入框 —— 如果业务要用内网私有源，
这里需要补一个输入框。**conda 侧的镜像不注入**，尊重用户 `~/.condarc` 里已有的配置（实测已配好清华源）。

### 7.2 任务注册

- 启动时扫描 `tasks\**\*.py`。
- 新发现的脚本 → 入库为待配置任务（`name` 暂用文件名，界面标「待命名」）。
- 磁盘上已消失的脚本 → 标记「脚本缺失」，不自动删除记录。
- 界面也可手动新建，且**脚本路径可以由用户自己指定**：相对 `tasks\`、本地绝对路径或
  UNC 网络共享路径都行，工作目录之外的一律**原地引用不复制**（修订 2，详见第 21 节）。

### 7.3 立即执行

点「执行」→ 建 Run(`queued`) → 按 `overlap_policy` 判定（`skip` 则记一条 `skipped` 并提示）→ `spawn` → 流式日志 → 收尾写 DB → 按需通知。

### 7.4 定时执行

- 应用启动时，从 DB 读所有 `enabled && cron_expr` 的任务，逐个注册到 croner。
- 触发时走与「立即执行」**完全相同**的入口，只把 `trigger` 记为 `schedule`。
- cron 表达式改动 = 反注册再注册。

### 7.5 日志流

`spawn` 的 stdout/stderr → 按行切分（同时处理 `\r\n` 与进度条用的裸 `\r`）→ 双写：

1. 追加到 `logs\<任务名>\<时间戳>.log`
2. `webContents.send('run:log', ...)`

渲染侧用缓冲区 + `requestAnimationFrame` 批量 flush，避免高频 IPC 拖垮 UI。日志文件超阈值（默认 20 MB）滚动截断。

### 7.6 停止与超时

Windows 下 **`child.kill()` 只杀直接子进程**。必须用进程树强杀：

```
taskkill /PID <pid> /T /F
```

超时到点走同一路径，Run 状态记 `timeout`；用户手动停记 `killed`。

### 7.7 子进程环境构造（关键）

不使用 `conda run`（多一层 shell 解析，中文路径与空格容易被二次拆分）。直接定位 `python.exe`，并手动构造环境：

```
PATH = <env>;<env>\Library\mingw-w64\bin;<env>\Library\usr\bin;
       <env>\Library\bin;<env>\Scripts;<env>\bin;  + 系统 PATH
CONDA_PREFIX        = <env>
CONDA_DEFAULT_ENV   = <env 名>
PYTHONIOENCODING    = utf-8      ← 不设则中文输出按 GBK 乱码
PYTHONUNBUFFERED    = 1          ← 不设则日志不实时
```

`spawn` 用**数组形式传参、不经 shell**，中文参数天然安全；`windowsHide: true` 避免弹黑窗；用 `python.exe` 而非 `pythonw.exe`（需要 stdout）。

---

## 8. 已知坑与对策

| 坑 | 对策 |
|---|---|
| better-sqlite3 是否要按 Electron ABI 重编译 | **不用**。v13 是 N-API + 包内自带 prebuilds，M1 已实测确认 |
| pnpm 10 默认拦截依赖的 build script，导致 Electron 二进制不下载 | package.json 里声明 `pnpm.onlyBuiltDependencies` |
| 原生 `.node` 打进 asar 后加载失败 | electron-builder 配 `asarUnpack` |
| electron-builder 对 pnpm 符号链接式 node_modules 支持不稳 | `.npmrc` 设 `node-linker=hoisted` |
| 单实例与重复调度 | `app.requestSingleInstanceLock()`，第二个实例唤起已有窗口 |
| 笔记本休眠 / 关机错过触发 | croner 不保证补偿。自维护 `last_run_at`，启动与唤醒时检查错过的触发，记 Run 状态 `missed`，由界面提示用户决定是否补跑 |
| 时区与夏令时 | croner 固定传 `timezone: 'Asia/Shanghai'` |
| 关窗即退出导致定时失效 | 拦截 `close` 事件 → 最小化到托盘；`app.setLoginItemSettings({openAtLogin:true})` 开机自启 |
| 定时任务在无人登录时不触发 | **本期接受**（托盘常驻），靠 4.2 的 `core/` 解耦预留服务化改造 |
| 高频日志刷爆 IPC | 渲染侧批量 flush + 日志文件截断 |

---

## 9. 里程碑

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M1 骨架 | electron-vite 起工程、Vue3 + Element Plus、单实例、托盘、DB 初始化与迁移 | ✅ 已完成（2026-10-04，六项验证全通过） |
| M2 环境层 | 首启向导、项目自带 conda 安装与校验、环境枚举、`python.exe` 解析 | ⚠️ 已被「修订」行取代（安装流程已删除） |
| M3 任务 CRUD | `tasks\` 扫描、中文名、环境绑定、界面列表与编辑 | ✅ 已完成（全链路自检通过） |
| M3.5 环境管理 | 选 Python 版本创建环境、装 requirements.txt、清华镜像 | ✅ 已完成（真实创建 + 装依赖联调通过） |
| **修订** | **Miniconda 改为「定位用户指定的安装」，删除项目内安装流程** | ✅ 已完成：项目 **3,949 MB → 643 MB**；自动探测到 `F:\Miniconda39`，列出 12 个环境 |
| M4 执行引擎 | 立即执行、日志流、退出码、超时、进程树强杀、运行记录 | ✅ 已完成（真实执行 / 超时 / 停止 / 并发策略全部实测通过） |
| M5 调度 | croner 持久化注册与恢复、重叠策略、错过补偿、表达式预览 | ✅ 已完成（真实定时触发 + 错过检测六场景通过） |
| M6 交付 | electron-builder NSIS、开机自启、通知（飞书 Webhook）、日志保留清理 | ✅ 已完成（安装包已构建并用静默安装+卸载全链路验证） |
| M7 在线更新 | electron-updater 接入、自动检查+自动下载、安装由用户确认、发布脚本与本地更新服务器 | ✅ 已完成（连续两轮真实更新验证通过，数据零丢失） |

---

## 10. 默认假设（**待确认**）

以下三点需求方尚未拍板，本文档按下列默认值推进，确认或推翻都会影响后续实现：

1. **调度可靠性**：本期做**托盘常驻**版本，接受「无人登录时不触发」；但 `core/` 不依赖 electron，将来搬进 Windows 服务时代码零改动。
2. **中文名与 py 的映射**：`name` 加 **UNIQUE 约束、不允许重名**，内部用 UUID 做键。业务同事认名字，重名会导致误操作。
3. ~~**任务注册方式**：以**扫描 `tasks\` 目录**为唯一来源，不允许引用 `tasks\` 之外的外部脚本路径~~
   → **已于修订 2 放宽**：扫描仍是「零配置发现」的入口，同时允许用户自己指定任意位置的 .py 路径（原地引用）。

---

## 11. M1 实测结论（已据此修正设计）

M1 骨架搭建过程中实测到的、推翻了原设计假设的事项：

| 事项 | 实测结论 | 处置 |
|---|---|---|
| Vite 8.3.2 与 electron-vite 5 | **不兼容**。electron-vite 5.0.0 的 peer 为 `vite@^5\|\|^6\|\|^7`，安装 Vite 8 产生 unmet peer | 锁 `vite@^7.3.6` |
| better-sqlite3 13.0.3 | GitHub release 的 assets 为**空**，一度判断"必须源码编译"；实际 v13 已改 **N-API** 且 npm 包内自带 `prebuilds/`（含 `win32-x64.node`） | **无需 `install-app-deps` 重编译**，Node 与 Electron 通用 |
| pnpm 10 的构建脚本拦截 | 默认拦截依赖的 build script，导致 **Electron 二进制未下载**（`node_modules/electron` 下无 `dist/`、`path.txt` 为空） | package.json 声明 `pnpm.onlyBuiltDependencies` |
| 本机工具链 | PATH 上的 `python` 是 **Microsoft Store 假壳**（真实 Python 不存在），且**无 MSVC 生成工具** | 任何需要 node-gyp 编译的方案在本机不可行，选型时必须坚持"纯预编译"路线 |
| pnpm 符号链接布局 | electron-builder 对 symlink 式 node_modules 支持不稳 | `.npmrc` 设 `node-linker=hoisted` |
| Electron 下载缓存外溢 | `ELECTRON_CACHE` **不被 `@electron/get` 识别**（它用 `env-paths` 硬算 `%LOCALAPPDATA%\electron\Cache`），首次安装实测在项目外产生 150.7 MB 文件，违反约束 C1 | 新增 `scripts/fetch-electron.mjs`，在子进程里改写 `LOCALAPPDATA` 后调用 electron 的 `install.js`，把缓存逼回项目内 |
| Electron 二进制未被 pnpm 安装 | 即便把 `electron` 写进 `onlyBuiltDependencies`、`ignoredBuilds` 里也没有它，其 postinstall 始终不执行 | 同上，`postinstall` 改为显式调用 `fetch-electron.mjs`，绕开 pnpm 的构建脚本门控 |
| 自检时 Electron 以纯 Node 模式运行 | 若环境里存在 `ELECTRON_RUN_AS_NODE=1`，`require('electron')` 会返回 npm 包的路径字符串，`electron.app` 为 undefined | 自检命令前清理该变量；这是环境坑，不是代码问题 |

> 结论：**本项目不允许引入任何需要本地编译的原生模块**，否则在业务同事机器上必然装不起来。

### 11.1 M1 验收结果（全部通过）

| 检查项 | 命令 | 结果 |
|---|---|---|
| 主进程类型检查 | `pnpm typecheck:node` | 通过（需先修 `baseUrl` 已被 TS 7 移除的问题，已回退 TS 5.9.3） |
| 渲染进程类型检查 | `pnpm typecheck:web` | 通过 |
| 生产构建 | `pnpm build` | 通过，产物 `out/main`、`out/preload`、`out/renderer` |
| 核心层自检 | `pnpm smoke` | `root=D:\RPA_Pilot`、`dbFile=data\app.db`、`schemaVersion=1`、`journalMode=wal` |
| **端到端自检** | `pnpm selftest` | 窗口加载、preload 桥（`apiBridge=function`）、IPC、Vue 挂载（`heading=RPA_Pilot`）全通 |
| 原生模块 | — | better-sqlite3 的 N-API 预编译包在 Electron 44 中直接可用，**零编译** |
| 约束 C1 审计 | — | 项目内：`.pnpm-store` 1.58 GB、`.cache` 150.7 MB；项目外仅剩其他项目的历史缓存，本次新增为零 |
| 约束 C2 | — | 全程未调用 `F:\Miniconda39`；`condaInstalled=false` 正确反映项目内尚未安装 |

**已知待优化**：渲染进程 JS 产物 2.6 MB / CSS 363 kB —— Element Plus 目前是全量引入。桌面应用加载本地文件，影响不大，M6 再考虑按需引入（`unplugin-vue-components`）。


---

## 12. 剩余风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| TypeScript 7.0.2 是原生重写版，vue-tsc 3.3.12 仅声明 `typescript >=5.0.0`，实际未必兼容 | typecheck 跑不起来 | M1 验证；不通则回退 `typescript@5.9.3` |
| 项目自带 Miniconda 使目录显著变大 | 分发成本 | 已选 C4 方案（不随包预置），安装包保持小体积 |
| conda 环境创建依赖网络（`conda create` 拉包） | 内网机器无法建环境 | M2 需支持「离线包导入」或明确提示错误 |
| 业务脚本依赖私有包 / 内部源 | 环境搭建失败 | 环境创建环节需可配置 pip / conda 镜像源 |
| 打包后数据目录落在安装目录，需确认可写 | 数据库写入失败 | M6 采用 NSIS 按用户安装（`%LOCALAPPDATA%\Programs`），该位置可写；若改为 Program Files 则必须改数据落点 |

---

## 13. M2 环境层实现要点 ⚠️ 本节已作废

> **本节描述的「把 Miniconda 装进项目目录」的整套实现已经删除。**
> 保留在这里只为记录当时的技术判断（NSIS 静默参数、安装包守卫、半成品目录清理等）——
> 如果将来真的要重新引入「项目内自带运行时」（例如要交付给完全没有 Python 的机器），
> 这些细节仍然有用。**当前方案见第 7.1 节。**

1. **环境枚举用「扫目录」而不是 `conda env list --json`**
   conda 会把注册过的、位于项目外的环境也列出来，那正是约束 C2 要排除的东西。扫
   `runtime\miniconda3\envs\` 下的子目录，天然只能看到项目内的环境；附带好处是不需要
   启动 conda 进程，快且无副作用。只列真正存在 `python.exe` 的目录，避免列出建到一半的坏环境。

2. **静默安装参数即约束 C2 的落实**
   ```
   /S /InstallationType=JustMe /RegisterPython=0 /AddToPath=0 /D=<runtime\miniconda3>
   ```
   `RegisterPython=0` 不注册为系统 Python，`AddToPath=0` 不写 PATH —— 这两条保证项目自带的
   Miniconda 不会去干扰机器上已有的 Python 环境。另外 `/D=` 必须放在**最后且不能加引号**
   （NSIS 的硬性限制），所以代码在动手前**预先拦截含空格的安装路径**并给出明确报错。

3. **安装包守卫前置**
   先判断存在性 / 类型 / 体积：小于 20 MB 的 `.exe` 直接判为无效（防止把 HTML 错误页或被杀软
   替换过的文件当安装包），避免安装走到一半才失败。Windows 版 Miniconda 官方只发 `.exe`；
   `.zip` 用 Windows 10 1803+ 自带的 `bsdtar` 解（不必为此引第三方库）并自动处理「多包一层
   顶层目录」的情况；`.msi` 等类型明确拒绝并说明原因。

4. **不伪造安装进度**
   NSIS 静默安装不提供任何进度输出，所以 UI 用**不定量进度条 + 阶段消息 + 本地计时器**，
   而不是编一个假的百分比。

5. **并发保护**
   主进程一个 `installInFlight` 标志，同一时刻只允许一个安装流程，避免并发写 `runtime\`
   产生半成品目录。

6. **安装包是「输入」，不复制进项目**
   用户在系统文件框里可以选项目外的 `.exe`；真正落地到项目内的只有 `runtime\miniconda3\`。

7. **必须把 conda 的 HOME 重定向进项目（实测踩到的约束 C1 违规）**
   Miniconda 安装器会往「用户主目录」写 conda 的环境注册表。首次联调时它往项目外的
   `C:\Users\<用户>\.conda\environments.txt` **追加了一行项目路径**（15 行 → 16 行，文件 hash 改变），
   违反约束 C1；副作用还让机器上外部 conda 的 `conda env list` 能看到我们的环境，违反 C2 精神。

   修法：`core/conda.ts` 的 `condaProcessEnv()` 把所有 conda 相关子进程的
   `USERPROFILE` / `HOME` / `CONDARC` 指向 `runtime\conda-home`。修复后重装实测，外部文件
   **逐字节未变**，conda 状态全部落在 `runtime\conda-home\.conda\` 内。
   **这个函数在 M3 创建环境时必须复用**，否则同样的问题会再犯一次。

8. **中文输出编码已实测确认，不是可选项**
   同一个解释器、`spawn` 时以 UTF-8 解码：

   | 环境变量 | 结果 |
   |---|---|
   | 设 `PYTHONIOENCODING=utf-8` | `"中文测试：你好，RPA_Pilot"`（与期望逐字符一致） |
   | 不设 | `"���Ĳ��ԣ���ã�RPA_Pilot"`（乱码） |

   执行器（M4）必须固定注入 `PYTHONIOENCODING=utf-8` 与 `PYTHONUNBUFFERED=1`。

### 13.1 M2 验收结果

| 检查项 | 结果 |
|---|---|
| 真实安装（走向导的 IPC 链路，非直接调核心层） | ✅ 26.7 秒装完 Python 3.14.7 到 `runtime\miniconda3` |
| 进度事件链路 | ✅ 渲染进程实收 4 个事件：`preparing → installing → verifying → done` |
| 解释器身份 | ✅ `sys.executable = D:\RPA_Pilot\runtime\miniconda3\python.exe`，不是外部 conda |
| 环境枚举 | ✅ `envNames: ["base"]`；外部 `F:\Miniconda39` 的 11 个环境一个都没出现 |
| 用户 PATH | ✅ 未被写入（`/AddToPath=0` 生效） |
| 约束 C1（外部文件） | ✅ 修复 HOME 重定向后，项目外文件逐字节未变 |
| 安装包守卫 | ✅ 不存在文件 / 过小 exe / `.msi` / `.zip` 四种输入判定均正确 |
| 常规自检回归 | ✅ 不带安装包时 `install: null`，状态读取正常 |

**已被触及的项目外状态（如实披露）**

| 位置 | 情况 | 处置 |
|---|---|---|
| `C:\Users\xbye\.conda\environments.txt` | 首次安装（修复前）被追加 1 行 | 已**精确还原**至基线 hash `75AD6E80A48C938A`；修复后不再发生 |
| `HKCU\...\Uninstall\Miniconda3 py314_26.7.1-1` | 按用户安装必然产生的卸载项（注册表不是文件，不违反 C1） | 保留，用户可从控制面板卸载；重装是覆盖而非新增 |
| `D:\RPA_Pilot\.cache\installers\Miniconda3-latest-Windows-x86_64.exe` | 联调用的安装包本体，126.4 MB | 保留在项目内，可随时删除 |

**体积**：项目总计 3.47 GB —— `runtime` 964.5 MB、`node_modules` 639.6 MB、
`.pnpm-store` 1.58 GB、`.cache` 277.1 MB。其中 `.pnpm-store` 是 pnpm 全局缓存的重定向，
即使删掉 `node_modules` 也会保留以加速重装。

---

## 14. M3 任务管理实现要点

1. **「待配置」必须是显式字段（迁移 v2）**
   自动发现的任务，中文名暂用文件名。用「名称是否等于文件名」来推断「用户还没配置过」
   是不可靠的（用户可能就是想让中文名等于文件名）。所以加了 `tasks.configured` 字段，
   只有用户在编辑框里保存过才置 1。

2. **启用开关走独立通道 `tasks:setEnabled`**
   最初复用了 `updateTask`，但那会把 `configured` 置 1 —— 在列表上点一下开关，
   不应该等于「用户确认了这个任务的配置」。所以拆出只改 `enabled` 的独立函数。

3. **约束 C1 在数据层再守一道**
   `normalizeScriptPath()` 拒绝一切指向 `tasks\` 之外的路径。实测拦截：
   ```
   脚本必须位于 tasks\ 目录内（约束 C1），收到：C:/Windows/System32/notepad.py
   ```
   界面只列 `tasks\` 内的文件是第一道，数据层校验是第二道 —— 前端被绕过也塞不进去。

4. **中文名唯一性：core 层显式校验 + 数据库 UNIQUE 兜底**
   显式校验是为了给出可读的中文提示，UNIQUE 约束是为了并发/意外路径下仍有保证。

5. **脚本消失不删记录，且「是否缺失」不落库**
   `scriptExists` / `envExists` 都是查询时用文件系统派生的状态，不存字段 ——
   存了就会过期（用户手动把脚本放回去，库里还显示缺失）。

6. **启动参数用「每行一个」而不是空格分隔**
   空格分隔在参数含空格时必然拆错（Windows 路径、中文名称都可能带空格）。
   界面上明确写了这一点。

7. **前端引入 vue-router（hash 模式）+ 侧边栏**
   桌面应用走 `file://`，必须 hash 模式。侧边栏是因为后面还有「运行记录」（M4）、
   「设置」（M6）页面，现在做比之后再重构便宜。

### 14.1 M3 验收结果（自检探针实际驱动）

| 检查项 | 结果 |
|---|---|
| 扫描 `tasks\` 发现脚本 | ✅ `scanned: 1`，中文名由文件名推导为 `示例_打招呼` |
| 自动发现的默认状态 | ✅ `configured: false`（待配置）、`envExists: true`（默认绑 base） |
| 删除记录 | ✅ 记录立即消失（`deletedGone: true`） |
| 中文名重复 | ✅ 被拒：`中文名称「自检任务-临时」已被其他任务占用，请换一个` |
| 项目外脚本路径 | ✅ 被拒：`脚本必须位于 tasks\ 目录内（约束 C1）` |
| 空中文名 | ✅ 被拒 |
| 编辑保存 | ✅ 名称更新、`configured` 变为 true、并发策略改为 `queue` 生效 |
| 启用开关 | ✅ `setTaskEnabled` 生效，且不会把 `configured` 置 1 |
| 删除 | ✅ 记录消失，`totalAfter: 1` |
| 删除后重新扫描 | ✅ 实测会被重新发现：`resyncAdded: 1`、`reappeared: true`、`reappearedConfigured: false` |
| 路由与视图渲染 | ✅ `heading: "任务管理"` |

> **需要你拍板的一个行为**：因为「以目录为唯一来源」是设计假设 3，删除任务后只要脚本还在
> `tasks\` 里，下次扫描就会把它重新登记为待配置。如果业务上需要「删掉就别再出现」，
> 得加一个「忽略清单」（表里存一条被忽略的 script_path）。目前**没有**做这个功能。

---

## 15. M3.5 环境管理实现要点

1. **镜像配置不是优化，是可用性前提**
   conda 默认走 `repo.anaconda.com`，国内直连创建环境经常几十分钟起步甚至直接超时失败。
   `ensureCondaConfig()` 会往 `runtime\conda-home\.condarc` 写清华镜像 ——
   因为 `condaProcessEnv()` 把 `CONDARC` 指到这里，所以**只对项目自带的 conda 生效**，
   不会碰用户自己的 conda 配置（约束 C1/C2）。文件已存在则不覆盖，避免把用户手工改过的配置打回去。

2. **pip 的镜像走环境变量，不写配置文件**
   `PIP_INDEX_URL` / `PIP_TRUSTED_HOST` 指向清华 PyPI。环境变量优先级高于 `pip.ini`，
   这样既能用上镜像，又不必去项目外写任何 pip 配置。

3. **环境名校验前置**
   只允许 `^[A-Za-z0-9][A-Za-z0-9._-]*$`、长度 ≤ 40、且不能叫 `base`。
   提前拦截比让 conda 报一个难懂的错要好。

4. **创建失败要清理半成品目录**
   conda create 中途失败会留下残缺目录。`cleanupPartialEnv()` 三重保险：
   必须是 `envs\` 的**直接**子目录、目录里**没有** `python.exe`、路径确实在项目内。任一条不满足就不删。

5. **依赖安装失败不回滚环境**
   环境本身是好的，用户改完依赖清单可以重来。所以报错信息明确写「环境已创建成功，但依赖安装失败」，
   而不是把整个环境删掉让用户重来一遍。

6. **requirements 临时文件用完立刻删**
   内容里可能含私有源地址甚至凭据，所以写在项目内、`finally` 里删掉，不留在磁盘上。

7. **并发保护**
   `envCreateInFlight` 标志：conda create 并发跑会互相抢包缓存。

### 15.1 M3.5 验收结果

| 检查项 | 结果 |
|---|---|
| 真实创建环境 | ✅ `conda create -n selftest_py311 python=3.11` + `pip install six`，总耗时 64.4 秒 |
| 进度事件 | ✅ 88 个事件，五个阶段齐全：`preparing → creating → verifying → installing-deps → done` |
| Python 版本隔离 | ✅ 新环境 `3.11.17`，base 是 `3.14.7` —— 不同任务可以用不同版本 |
| 依赖真的装上了 | ✅ `six 1.17.0`，位于该环境的 `Lib\site-packages\six.py` |
| 镜像实际生效 | ✅ `Looking in indexes: https://pypi.tuna.tsinghua.edu.cn/simple` |
| `.condarc` 落点 | ✅ `runtime\conda-home\.condarc`（项目内） |
| 环境枚举 | ✅ `["base", "selftest_py311"]` |
| 临时 requirements 清理 | ✅ 无残留 |
| 约束 C1 | ✅ 外部 `environments.txt` 的 hash 仍是基线 `75AD6E80A48C938A`、15 行 |
| 体积 | `selftest_py311` 仅 160.8 MB（conda 用硬链接共享包缓存，比预期省） |

> **遗留缺口**：环境**删除**功能没做（选项 B 的范围里不含它）。联调留下的
> `selftest_py311` 现在只能靠手动删目录才能去掉 —— 这说明删除功能在真实使用中会被需要。
> （注：该测试环境随项目内 Miniconda 一起被删除，不再存在。）

---

## 16. 环境与构建的坑（累计清单）

这些是实际踩过的，按「下次一定会再遇到」的程度排序：

| 坑 | 现象 | 对策 |
|---|---|---|
| pnpm 10 拦截依赖的 build script | `better-sqlite3`、`esbuild` 等的 postinstall 不执行 | 在 `package.json` 的 `pnpm.onlyBuiltDependencies` 里点名放行 |
| **Electron 的 postinstall 即使放行也不执行** | `node_modules/electron` 下没有 `dist/`、`path.txt` 为空，应用起不来；而它在 `ignoredBuilds` 与 `pendingBuilds` 里**两边都查不到** | 用 `scripts/fetch-electron.mjs` 显式调用 electron 的 `install.js`，绕开门控 |
| 换 pnpm store 位置后 `pnpm install` 直接失败 | `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` —— pnpm 要清掉 `node_modules` 重装，非交互环境需确认 | 设环境变量 `CI=true` 再跑 |
| 用户全局 pnpm store 不在默认位置 | 本机是 `D:\.pnpm-store`（非 `%LOCALAPPDATA%\pnpm\store`） | 不要假设默认路径；用 `pnpm store path` 实测 |
| `@electron/get` 的缓存**无法用环境变量覆盖** | `ELECTRON_CACHE` 完全无效，缓存硬编码到 `%LOCALAPPDATA%\electron\Cache` | 若确需改位置，只能在 `import` 之前改写 `process.env.LOCALAPPDATA`（env-paths 在调用时读它） |
| `ELECTRON_RUN_AS_NODE=1` 残留 | Electron 以纯 Node 模式启动，`require('electron')` 返回**npm 包的路径字符串**，`electron.app` 是 undefined | 自检前清理该变量；这是环境坑不是代码问题 |
| `app.exit()` 的退出码在 PowerShell 管道里读不到 | `$LASTEXITCODE` 为空，工具还可能报 `[exit code: 1]` | 用 `Start-Process -Wait -PassThru` 读 `.ExitCode`，实测是 0 |
| Chromium 的 `WSALookupServiceBegin` 警告 | 写到 stderr，容易被判成失败 | 属良性警告，与业务无关 |
| PowerShell 默认按 GBK 解码 UTF-8 | 看中文输出全是乱码，容易误判成程序出错 | 核对文本内容用 Node 读，或显式指定编码 |
| 模板字面量的闭合反引号被写错 | TypeScript 把模板字面量一路吞到后面几十行，报出一堆**看似无关**的错误 | 别猜，用 Node dump 出那几行的精确内容；报错行号可能完全不是问题所在 |
| `@types/node` 26 的 `readdirSync` 类型推断 | 不指定 `encoding` 时 `Dirent.name` 被推成 `Buffer`，`startsWith` 等全部报错 | 显式写 `{ withFileTypes: true, encoding: 'utf8' }` |

---

## 17. M4 执行引擎实现要点

1. **直调 `<env>\python.exe`，不用 `conda run`**
   少一层 shell 解析。参数用**数组形式**传给 `spawn`、不经 shell，所以中文路径和含空格的参数天然安全。

2. **两个环境变量是必需的，不是优化**
   - `PYTHONIOENCODING=utf-8`：不设则 Windows 下中文输出按 GBK 编码，读出来是乱码（已实测）
   - `PYTHONUNBUFFERED=1`：不设则日志要等进程结束才一次性吐出来，界面看不到实时输出
   - 另外把该环境的目录前置到 `PATH`，让 numpy/MKL 这类带 DLL 的包能正确加载

3. **Windows 上必须用 `taskkill /PID <pid> /T /F`**
   `child.kill()` 只杀直接子进程，脚本自己拉起的孙子进程会变成孤儿。实测超时 2 秒的任务在
   2.35 秒时结束，被杀的 pid 确认已不存在。

4. **一次运行一个日志文件，带表头表尾**
   `logs\<任务名>\<时间戳>_<runId前6位>.log`，表头记录任务名、脚本绝对路径、环境、解释器、工作目录、
   触发方式、开始时间；表尾记录结束时间、状态、退出码、耗时。这样单个文件即可自证这次运行的全部上下文，
   不必回查数据库。

5. **配置层面的错误也要留一条运行记录**
   环境缺失 / 脚本被删 / 工作目录不存在，这些在执行前就能发现。如果直接抛错，
   用户在界面上点了「执行」会**什么都没发生**。所以这些情况会写入一条 `failed` 记录并带上原因。

6. **启动时收尾残留记录（`reconcileStaleRuns`）**
   上次崩溃或强杀会在库里留下 `running` / `queued` 的记录。不收尾的话界面永远显示「正在运行」。

7. **退出时清理子进程（`stopAll`）**
   客户端都关了还留着后台进程跑脚本更让人困惑，所以 `before-quit` 里一并终止。
   （自检模式用的是 `app.exit()`，不触发 `before-quit`，所以自检代码里显式调了一次。）

8. **并发策略 skip / queue / allow 都实现了**
   `skip` 记一条 `skipped`；`queue` 记一条 `queued` 并在前一个结束后自动接上；`allow` 直接并行。

9. **重试只针对「程序自己失败」**
   超时与手动终止不重试 —— 重试一个超时任务只会再超时一次。

10. **日志读取有上限**
    渲染进程读日志只取最后 512 KB（大日志可能是几百 MB），界面内存里最多保留 5000 行。

### 17.1 M4 验收结果（自检探针真实驱动）

| 检查项 | 结果 |
|---|---|
| 正常执行 | ✅ `status: success`、`exitCode: 0`（数字，不是 null） |
| 实时日志流 | ✅ 渲染进程实收 5 行，且其中包含正确中文（`liveHasChinese: true`） |
| 日志文件 | ✅ 表头 / 中文输出 / Python 版本 / 表尾状态齐全 |
| **超时终止** | ✅ `status: timeout`，摘要「执行超时，已强制终止整个进程树（pid …）」 |
| 超时精度 | ✅ 设 2 秒，实际 2.35 秒结束；日志里能看到跑到第 3 秒 |
| 超时日志 | ✅ 文件里记录了 `# 状态：timeout` 与 `# 退出码：1` |
| **手动停止** | ✅ `status: killed` |
| 进程树清理 | ✅ 被杀 pid 确认已不存在，且无孤儿 python 进程 |
| **并发策略 skip** | ✅ 进程还在跑时再点执行 → `skipped`，并给出中文说明 |
| 活动进程查询 | ✅ 运行期间 `listActiveRuns()` 返回 1 |
| 界面桥接 | ✅ `runBridge: "function"`、`heading: "任务管理"` |

> **已知限制**：失败重试的链条计数存在内存里，客户端重启会丢失（重启后按首次尝试计算）。
> 对桌面单机场景影响很小，但如果将来要严格审计重试次数，需要把 attempt 落到 runs 表里。
>
> **另一个决策点**：`runs` 表对 `tasks` 是 `ON DELETE CASCADE`，所以删除任务会一并删掉它的运行历史。
> 如果业务上需要「任务删了但历史留着」，这里要改成软删除或把 runs 与 tasks 解耦。

---

## 18. M5 定时调度实现要点

### ⚠️ croner 的两个 API 名字很像、语义完全不同（实测踩到）

| 调用 | 实际语义 | 后果 |
|---|---|---|
| `job.previousRun()` | **上一次实际执行**的时间（croner 内部跟踪） | 任务从没跑过时返回 `null`；用它做错过检测会**永远检测不出来** |
| `job.previousRuns(1)` | **按表达式反推**的上一次应触发时刻 | 这才是错过检测需要的 |

`previousRun()` 与 `previousRuns(n)` 只差一个 `s`。第一版实现用错了，是靠「独立脚本构造场景」测出来的 ——
在应用里运行期间根本测不出来（因为任务一直在正常触发）。

### 其它要点

1. **调度器职责边界**：只判断「到点了」，启动进程与并发策略（跳过/排队/并行）统一交给 runner。
   两处各写一套判断必然分叉。

2. **错过触发的三道防误报**
   - 任务创建时间晚于那次触发 → 当时任务还不存在，不算错过
   - 该时间之后已有任何运行记录（含 missed）→ 不重复记（用确定性主键 `taskId-missed-<时间>` 兜底）
   - **触发间隔 ≤ 5 分钟的任务直接跳过**：否则一个「每分钟」的任务几乎每次启动客户端都会刷一条
     missed，纯属噪音，而这类任务错过一次也无所谓

3. **刻意不做自动补跑**
   一个「每天 8 点导数据」的任务在下午被自动补跑，后果可能比不跑更糟。
   所以只记一条 `missed` 并在运行记录页给出「补跑」按钮，由人决定。

4. **croner 的 job 会持有定时器，阻止进程退出**
   测试脚本里忘了 `stopScheduler()` 导致 node 进程一直不结束。应用侧在 `before-quit` 里已经调了，
   但这是个容易忽略的点：**只要注册过 job，不显式停掉进程就退不干净**。

5. **非法表达式在注册时就被捕获并展示**
   `jobErrors` 会把构造失败的原因记下来，界面上直接显示在「定时 / 下次运行」列里，
   而不是悄悄不生效让用户以为设好了。

### 18.1 M5 验收结果

**应用内真实触发**（自检探针把示例任务改成每 2 秒触发，然后等它自己跑起来）

| 检查项 | 结果 |
|---|---|
| 注册成功 | ✅ `registered: true`、`registerError: null` |
| 下次触发时间可算出 | ✅ `nextRun` 有值 |
| **定时真的触发了** | ✅ `triggered: true`、`triggerStatus: "success"` |
| 表达式预览 | ✅ 预览返回 5 次，`0 8 * * *` 全部落在 8 点（`previewAllAt8: true`） |
| 非法表达式被拒 | ✅ `badCronRejected: true` |
| 清空 cron 后正确注销 | ✅ `stillRegisteredAfterDisable: false` |

**错过触发检测**（独立脚本构造场景，因为应用运行期间不可能出现「客户端没开」）

| 场景 | 期望 | 结果 |
|---|---|---|
| 每日 8 点任务，3 天前创建、期间无运行记录 | 记 1 条 | ✅ 1 |
| 再查一次 | 不重复记 | ✅ 0 |
| 刚跑过一次 | 不算错过 | ✅ 0 |
| 任务在上一次触发之后才创建 | 不算错过 | ✅ 0 |
| 每分钟的高频任务 | 按频率门槛跳过 | ✅ 0 |
| 非法表达式 | 不崩溃 | ✅ 0 |

记下来的 missed 内容形如：
```
客户端未运行期间错过了一次定时触发（应为 2026/10/4 08:00:00），未自动补跑
```

---

## 19. M6 交付实现要点

### ⚠️ 最坑的一条：开发版与打包版共用同一个 userData

**症状**：打包出来的 `RPA_Pilot.exe` 双击后**约 0.8 秒后以退出码 0 静默退出**，
不弹窗、stderr 全空、不创建任何数据目录，看起来像「程序什么都没干就没了」。

**排查过程**（值得记录，因为每一步都在排除一个错误假设）：

| 假设 | 验证方式 | 结果 |
|---|---|---|
| 打包的 asar 内容坏了 | 用开发版 Electron 加载该 asar | ❌ 假设不成立：smoke 通过、better-sqlite3 正常、schemaVersion=2 |
| 打包 exe 无法加载任何应用 | 塞一个最小应用到 `resources/app/` | ❌ 假设不成立：最小应用能跑（标记文件写在 `%APPDATA%\probe\`，我第一次查错了目录） |
| asar integrity 校验失败 | 用 `-c.asar=false` 重新打包 | ❌ 假设不成立：关掉 asar 后症状完全一样 |
| 缺少 Electron 运行时文件 | 列 `win-unpacked` 内容 | ❌ 文件齐全，exe 尺寸与原始 electron.exe 完全一致 |
| 杀软拦截 | 查 Defender 记录 | ❌ Defender 实时防护本来就是关的，无拦截记录 |
| 单实例锁 / 残留进程 | 查进程与锁文件 | ❌ 无残留进程、无锁文件 |
| **userData 被开发版污染** | 删掉 `%APPDATA%\rpa-pilot` 再运行 | ✅ **成立**：删掉后立刻正常启动 |

**根因**：开发版 Electron 与打包版使用**同一个应用名**，因此共用
`%APPDATA%\rpa-pilot` 这个 userData 目录。我在调试期间用开发版 Electron 反复加载过打包产物，
在那个目录里留下了开发版写入的状态；此后打包版启动时读到它就直接静默退出了。

**教训与对策**：
1. 验证打包产物时，**先删掉 userData 再测**，否则测的是「被污染的现场」而不是产物本身。
2. 同一台机器上交替跑开发版和打包版，本来就会互相干扰 —— 这不是产品缺陷，
   正式交付时同事机器上只有打包版，不会遇到。
3. 之所以能发现，全靠 `boot.log`（见下条）。**没有它这个坑基本查不出来。**

### 交付相关的其它要点

1. **`boot.log` 是必需品，不是调试残留**
   打包后的应用是 **GUI 子系统程序，stdout 根本不会连到控制台** ——
   任何启动期异常在用户机器上都是「双击没反应」。
   所以启动诊断日志写在 `%APPDATA%\rpa-pilot\boot.log`（唯一在应用跑起来前就一定可写的位置），
   逐行记录：单实例锁结果、工作目录、数据库、IPC、窗口、托盘，以及
   `uncaughtException` / `unhandledRejection` / `before-quit` / `quit`。

2. **打包后的应用不接受自定义命令行开关**
   `RPA_Pilot.exe --smoke` → `bad option: --smoke`，**退出码 9**（Node 的参数解析器行为）。
   用 `-- --smoke` 也不行（会被当成入口模块路径，报 `Cannot find module '--smoke'`）。
   连 Chromium 的 `--user-data-dir`、`--enable-logging=file` 都被拒。
   **结论：打包产物的自检开关必须走环境变量**（`RPA_PILOT_SMOKE=1` / `RPA_PILOT_SELFTEST=1`）。

3. **数据与日志放 `%LOCALAPPDATA%\RPA_Pilot`，不放安装目录**
   安装目录在升级/卸载时会被动，数据放那里迟早丢。
   用 `LOCALAPPDATA` 而不是 Electron 默认的 `userData`（Roaming）——
   公司域环境下 Roaming 会被同步到服务器，几百 MB 日志跟着同步是灾难。

4. **`npmRebuild: false` 是必需的**
   electron-builder 默认会对原生模块做 `@electron/rebuild`，那需要 MSVC 工具链 + 联网下载
   Electron 头文件（实测直接连接超时，本机也没有 MSVC）。
   而 better-sqlite3 v13 是 **N-API + 包内自带 prebuilds**，Node 与 Electron 之间 ABI 通用，
   **根本不需要重编译**。开着它只会让打包必然失败。

5. **打包工具的下载必须预置（`scripts/prefetch-builder-tools.mjs`）**
   electron-builder 打包 Windows 安装包需要 winCodeSign / nsis / nsis-resources，
   默认从 GitHub 下载，实测约 60 KB/s，会在 got 的 600 秒请求超时上直接失败。
   - 只设 `ELECTRON_BUILDER_BINARIES_MIRROR` **不够**（实测仍然超时）
   - 而且新版 electron-builder 的缓存目录布局是 `Cache\<releaseName>\<文件名>-<URL哈希>`，
     旧版留下的目录它**根本不认**
   - 可靠做法：自己从国内镜像把三个 `.7z` 下载下来、**校验官方 SHA256**、
     放进 `Cache\<releaseName>\<文件名>` —— `downloadAndExtract` 会先查这个位置，
     命中就完全不发网络请求

6. **`build:win` 里必须设 `ELECTRON_MIRROR`**
   否则 electron-builder 会从 GitHub 重新下载 150 MB 的 Electron 压缩包。
   原因是 `@electron/get` 的**缓存 key 基于下载 URL** ——
   即使本地已经有一份走镜像下好的包，URL 不同就是 cache miss。
   设了镜像之后命中已有缓存，打包耗时从 **553 秒降到 64.5 秒**。

### 19.1 M6 验收结果

| 检查项 | 结果 |
|---|---|
| 安装包构建 | ✅ `RPA_Pilot-0.1.0-setup.exe`，**114.95 MB**，构建 64.5 秒 |
| 打包内容正确 | ✅ asar 只含 `out/`(10 项) + `package.json` + 生产依赖(151 项)；**源码/任务/日志/数据都没打进去** |
| 原生模块 | ✅ better-sqlite3 的 `.node` 正确解包到 `resources\app.asar.unpacked\` |
| 托盘图标 | ✅ `resources\icon.png` 就位 |
| **打包版启动（全新环境）** | ✅ 存活 > 12 秒（托盘常驻），创建 `data\app.db`、`tasks\`、`logs\` |
| **打包版启动（二次启动）** | ✅ 同样正常 |
| 启动日志 | ✅ boot.log 记录到「托盘已创建，启动完成」 |
| **静默安装** | ✅ 退出码 0，16.3 秒 |
| **装出的程序可运行** | ✅ 正常启动并建库 |
| 快捷方式 | ✅ 桌面 `RPA_Pilot.lnk` + 开始菜单 `RPA_Pilot.lnk` |
| **卸载** | ✅ 退出码 0，安装目录与快捷方式清除，**数据目录按配置保留** |
| 自启开关 | ✅ 开发模式下正确拒绝（`autoStartSupported: false`） |
| 失败通知 | ✅ 系统通知可用；未配置 Webhook 时正确跳过飞书 |
| 日志清理 | ✅ 保留天数往返生效（30→14→30）、清理统计正确 |

---

## 20. M7 在线更新实现要点

### 方案

**electron-updater 6.8.9 + generic provider（内网静态服务器）**。

不用 GitHub Releases / S3：公司内部工具，代码不该往公网放；静态托管只要一个能放文件的
IIS/Nginx 目录，运维成本最低。用 electron-updater 而不是自己写，是因为它替你做掉了三件麻烦事：
sha512 校验、**差量下载**（`.blockmap` 只下变化分块）、以及调用安装器静默升级并重启。

更新目录里必须有三个文件，缺一不可：

```
latest.yml                          ← 入口：版本号 + 安装包 sha512 + 大小
RPA_Pilot-<版本>-setup.exe           ← 安装包本体
RPA_Pilot-<版本>-setup.exe.blockmap  ← 差量下载的分块索引
```

### 关键决策

1. **`autoInstallOnAppQuit` 必须显式关掉**
   electron-updater 的默认值是 `true` —— 退出客户端就静默装上。
   这与需求方选定的「安装由用户确认」直接矛盾，所以初始化为 `false`，
   只在用户打开「退出时自动安装」开关时才设成 `true`。

2. **更新源三级解析**（优先级从高到低）
   - `RPA_PILOT_UPDATE_URL` 环境变量 —— 供联调与特殊部署覆盖
   - 设置表 `updateFeedUrl` —— 界面可改，**不需要重新打包**
   - 打包时烘进 `resources\app-update.yml` 的默认值

   做成可配置而不是写死，是因为内网地址经常变，而每次改地址都重新打包发版不现实。

3. **安装前置守卫：有任务在跑一律不许装**
   安装会退出应用，而 `before-quit` 里会 `stopAll()` 杀掉正在运行的 Python 进程。
   所以 `installUpdate()` 会检查 `listActiveRuns().length`，大于 0 就直接拒绝并说明原因；
   界面上也会禁用按钮并显示「还有 N 个任务正在运行」。

4. **数据目录的选择在这里得到回报**
   数据在 `%LOCALAPPDATA%\RPA_Pilot`，不在安装目录 —— 更新只替换安装目录，
   任务配置、运行历史、日志、任务脚本全部原样保留。这一点用真实更新做了严格验证（见下）。

5. **`oneClick: false` 的安装包同样支持静默更新**
   NSIS 模板里有 `skipPageIfUpdated` 宏：electron-updater 调用安装器时带 `--updated`，
   安装向导会跳过全部页面直接升级到原目录。**不需要为自动更新改动安装器配置。**

6. **顺带修掉一处设计与实现的偏差**
   设计文档 7.2 写的是「启动时扫描 `tasks\` 目录」，但实现里只在点「扫描」按钮时才扫，
   导致新装客户端的工作目录里放了 .py 却不显示任何任务。现在启动时会扫一次并自动登记为待配置任务。

### 发布流程

```bash
pnpm run build:win           # 构建，产出 out-installer\ 与 latest.yml
pnpm run publish:update      # 整理成可上传的 updates\ 目录（默认保留最近 3 个版本）
pnpm run update:server       # 本机联调：在 127.0.0.1:8787 托管 updates\
```

`publish-update.mjs` 只发布 `latest.yml` 指向的那个版本 —— 第一版不是这样，
它把 `out-installer\` 里的文件全拷过去，而那是历次构建的累积目录，
结果把早已发布的旧版本又搬回更新目录。这个坑已修。

**回滚的正确做法**：electron-updater 不会降级，所以「回滚」是把旧版本的代码打成
**更高的版本号**重新发布，而不是把 `latest.yml` 换回旧的。历史安装包别急着删。

### 排查过程中两次误判（值得记下来）

打包后的应用有一段时间**双击后约 1 秒静默退出、零副作用、无任何日志**。我先后误判了两次：

| 误判 | 为什么看起来像 | 实际 |
|---|---|---|
| asar integrity 校验失败 | 关掉 asar 打包后现象「一样」 | 那次测试本身是错的（见下） |
| electron-updater 加载失败把主进程带崩 | 该构建唯一的新增依赖就是它 | asar 里 20 个顶层包齐全，`require` 与构造 `autoUpdater` 都正常 |

**真因**：同一台机器上**多个实例抢单实例锁**。当时用户自己装的 `F:\RPA_Poilt` 实例还在托盘里运行，
我后续每一次启动都被 `requestSingleInstanceLock()` 挡掉并 `app.quit()` —— 干净退出、退出码 0，
与「程序什么都没干」的表象完全一致。

**教训**：
1. 验证打包产物前先 `Get-Process` 确认没有别的实例在跑，否则测到的是「锁竞争」不是产物本身。
2. **上一节 M6 记的「dev 与打包版共用 userData 会互相污染」是另一个独立现象**，
   两者都表现为静默退出，极易混淆 —— 这也是这次连续误判的原因。
3. 二分法要保证**对照组是干净的**：我那次「关掉 asar 也一样失败」的结论，
   是在有另一个实例占着锁的情况下得出的，属于无效对照。

### 20.1 M7 验收结果

用真实构建、真实安装、真实更新做了**连续两轮**验证（0.1.0 → 0.1.1 → 0.1.2）：

| 检查项 | 结果 |
|---|---|
| 本地更新服务器 | ✅ `127.0.0.1:8787` 正常托管，支持 HEAD 与 Range |
| `latest.yml` 产出 | ✅ 含 version / sha512 / size；`app-update.yml` 写入 `resources\` |
| 自动检查 | ✅ 真实观察到 25 秒延迟后的自动检查请求（服务器日志有记录） |
| **第一轮更新 0.1.0 → 0.1.1** | ✅ **20 秒**完成：检查 → 发现 0.1.1 → 自动下载 → 安装 → 重启 |
| **第二轮更新 0.1.1 → 0.1.2** | ✅ **22 秒**完成 |
| 静默升级 | ✅ NSIS 以 `--updated` 跳过向导，装回原目录；无需管理员权限 |
| 更新后自动重启 | ✅ boot.log 记录到以新版本启动（`version=0.1.2`） |
| **数据零丢失** | ✅ 更新前写入的 1 条任务（含 cron `0 8 * * *`）、1 条运行记录、1 条设置项**全部完好** |
| 任务脚本文件 | ✅ `tasks\` 下的 .py 原样保留 |
| 运行中任务拦截 | ✅ 由 `activeRunCount > 0` 判定并拒绝安装（界面禁用 + 中文原因） |
| 更新日志 | ✅ `%APPDATA%\rpa-pilot\update.log` 记录每次检查/下载/安装的全过程 |

`update.log` 里一次完整更新的记录：

```
--- 启动 updater 当前版本 0.1.0，更新源 http://127.0.0.1:8787/（来源：env）---
用户手动触发检查更新 → 开始检查更新 → 发现新版本 0.1.1
按设置自动开始下载 → 开始下载更新包 → 新版本 0.1.1 已下载完成，等待用户确认安装
用户确认安装，开始退出并安装更新
```

> **生产环境注意事项**
> - 内网若用**自签 HTTPS 证书**，Electron 会拒绝下载（更新请求不走页面，`certificate-error` 拦不住）。
>   要么用受信任的内网 CA，要么先走 HTTP。
> - 更新目录的**写权限要收紧**：不签名的话，谁能写那个目录谁就能给所有客户端推任意代码。
>   `latest.yml` 里的 sha512 只保证传输没坏，不保证来源可信。

---

## 21. 任务可以引用工作目录之外的 .py（修订 2）

### 为什么改

原设计规定「脚本必须位于 `tasks\` 内」，任务只能靠扫描发现。实际用起来这个限制不成立：
业务脚本往往已经在别的地方了 —— 本机别的盘、或者由别人维护的网络共享盘。
强迫用户把文件搬进工作目录既啰嗦，又会带来新坑（搬了一份之后，改源文件不生效）。

### 做法

**新建/编辑任务时自己指定 .py 路径，原地引用，不复制。** 支持三种写法：

| 写法 | 例子 | 存储形式 |
|---|---|---|
| 相对 `tasks\` | `报表\日报.py` | 相对路径 |
| 本地绝对路径 | `D:\我的脚本\日报.py` | 绝对路径 |
| UNC 网络共享 | `\\服务器\共享\日报.py` | 绝对路径 |

落在 `tasks\` 内的仍然存相对路径 —— 既便于整体备份迁移，也让扫描同步的重名判断保持一致；
工作目录之外的一律存绝对路径。

### 关键的实现约束（这是最容易写错的地方）

**任何判断「脚本还在不在」的地方，都必须走 `resolveScriptPath(paths, scriptPath)`，
不能自己写 `join(paths.tasksDir, scriptPath)`。** 后者会把外部引用的任务全部误报成「脚本缺失」。

本次一并改掉的四处：

| 位置 | 原来的写法 | 现在 |
|---|---|---|
| `toView()` 的 `scriptExists` | `join(tasksDir, ...)` | `resolveScriptPath()` |
| `syncTasksFromDisk()` 的 `missing` 统计 | `join(tasksDir, ...)` | `resolveScriptPath()` |
| `runner.resolveRunTarget()` 的脚本解析 | `resolve(tasksDir, ...)` | `resolveScriptPath()` |
| 执行时相对 `cwd` 的解析基准 | `tasksDir` | **脚本所在目录**（与界面「留空 = 脚本所在目录」一致，外部脚本也不会莫名跑到工作目录去） |

另外新增 `scriptExternal` 字段贯穿到界面，任务列表上给外部脚本打「外部」标签，
并提供一个「定位」按钮在资源管理器里打开它 —— 外部路径本来就容易找不到。

### 校验规则

| 情况 | 行为 |
|---|---|
| 新建时文件不存在 | **拒绝**（不让用户建出一个当场就跑不起来的任务） |
| 编辑时文件不存在 | **允许保存**（脚本临时被移走时，用户仍要能改名、改定时） |
| 非 `.py` 扩展名 | 拒绝 |
| 路径指向目录 | 拒绝 |
| 用户输入路径时 | 300 ms 防抖调 `tasks:inspectScript` 即时反馈：会解析成什么绝对路径、能不能用、是否外部引用 |

### 21.1 验收结果

自检里真的**在系统临时目录建了一个外部 .py（在 `tasks\` 之外、也在项目之外）并执行它**：

| 检查项 | 结果 |
|---|---|
| 外部绝对路径建任务 | ✅ 成功，且被识别为外部引用（`scriptExternal=true`） |
| 存储形式 | ✅ 以绝对路径存储（确认是原地引用而非复制） |
| 非 .py 被拒 | ✅ |
| 不存在的 .py 被拒 | ✅ |
| 绝对路径但文件不存在被拒 | ✅ |
| 即时校验（外部 / 工作目录内） | ✅ 两种都判断正确 |
| **扫描同步不误报** | ✅ 有外部引用任务时 `syncTasks().missing === 0` |
| **外部脚本真的跑起来** | ✅ `status=success`、`exitCode=0`，日志含脚本输出 |
| **工作目录默认落在脚本所在目录** | ✅ 日志里打印的 `os.getcwd()` 等于外部脚本所在目录 |

回归项（示例任务发现、重名拒绝、正常执行、超时强杀、并发跳过、手动停止、cron 触发、日志保留）
全部保持通过。

### 本次**没有**做的

- **没有**做「在界面上新建一个 .py 文件」的能力（会生成模板代码那种）。
  本次只做「指定一个已存在的 .py」。需要的话可以再加。










