# -*- coding: utf-8 -*-
"""
示例任务：模拟耗时较长的任务，用于验证「超时终止」与「手动停止」。

它会每秒输出一行，持续 60 秒。
配合任务配置里的「超时秒数」，或者界面上的「停止」按钮使用。
"""

import sys
import time
from datetime import datetime

TOTAL_SECONDS = 60


def main() -> None:
    print(f"长任务开始：{datetime.now():%H:%M:%S}，预计运行 {TOTAL_SECONDS} 秒", flush=True)
    print(f"解释器：{sys.executable}", flush=True)

    for second in range(1, TOTAL_SECONDS + 1):
        print(f"已运行 {second} 秒…", flush=True)
        time.sleep(1)

    print("长任务正常结束", flush=True)


if __name__ == "__main__":
    main()
