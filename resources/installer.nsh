; RPA_Pilot 安装器自定义脚本（electron-builder 自动从 buildResources 目录加载）。
;
; 背景：在线更新走「向导模式」（oneClick=false）。electron-builder 的模板在这个模式下，
; 安装完成后只有完成页的「运行程序」勾选框会启动应用 —— 模板源码里写得明白：
;   "for assisted installer run only if silent, because assisted installer has run after finish option"
; 即 --force-run 仅静默安装生效。用户点 X 关掉向导就会跳过启动，表现为
; 「装完没有自动重启」（boot.log 里新进程 argv 为空，而非 --updated，可证）。
;
; 兜底：customInstall 在「文件已落盘、注册表与快捷方式已写好」之后执行，
; 只要是覆盖更新（--updated）就立刻拉起新版本，不等完成页。
; 全新安装不在此启动 —— 那是用户主动装机，留给完成页的勾选框自己决定。

!macro customInstall
  ${if} ${isUpdated}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "--updated"
  ${endif}
!macroend
