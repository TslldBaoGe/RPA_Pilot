# -*- coding: utf-8 -*-
"""
示例任务：验证客户端能否正确执行脚本并显示中文日志。

放在 tasks\ 目录下的 .py 会被客户端「扫描」发现。
这个脚本不做任何危险操作，可以放心手动执行。
"""

import sys
from datetime import datetime


def main() -> None:
    print(f"你好，RPA_Pilot！当前时间：{datetime.now():%Y-%m-%d %H:%M:%S}")
    print(f"解释器：{sys.executable}")
    print(f"Python 版本：{sys.version.split()[0]}")

    if len(sys.argv) > 1:
        print(f"收到的参数：{sys.argv[1:]}")
    else:
        print("没有收到启动参数")

    print("示例任务执行完毕")


if __name__ == "__main__":
    main()
