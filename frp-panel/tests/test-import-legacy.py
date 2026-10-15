#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
回归测试：从第三方面板的 frps-tokens.toml 迁移账号。

背景（真实踩过的坑）：
    我最初按 `[[tokens.xxx]]`（双括号）写解析器，但第三方面板 2.0.0 实际写出的是
    **单**方括号 `[tokens.xxx]`，而且 ports 里还可能写成区间字符串 `"28888-28890"`。
    照原样跑，迁移会**导入 0 个账号** —— 直接卡住部署。

    这个教训来自拿**真实文件**跑了一遍（而不是拿自己造的样本）。
    所以本测试里的样本刻意照抄真实格式。

关键安全性质：
    默认**只导入 `dcfrp_` 前缀**的账号；面板里那些管理员手工维护的历史账号
    必须原样跳过，不能被自动流程接管。
"""
import json
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import panel  # noqa: E402

# 照抄真实文件的格式（单方括号 + 区间端口 + 中文 comment）
LEGACY = """[tokens]
    [tokens.123]
        user = "123"
        token = "741852963"
        comment = ""
        ports = [22245, 22256]
        domains = [""]
        subdomains = [""]
        enable = true
    [tokens.AOS]
        user = "AOS"
        token = "00000000A"
        comment = "奥数-10.25"
        ports = ["28888-28890"]
        domains = [""]
        subdomains = [""]
        enable = true
    [tokens.dcfrp_deadbeef]
        user = "dcfrp_deadbeef"
        token = "TokEnDeadBeef"
        comment = "DoulorCloud | active | 到期 2026-11-12"
        ports = [31000, 31001, "31200-31202"]
        domains = [""]
        subdomains = [""]
        enable = true
    [tokens.dcfrp_cafe]
        user = "dcfrp_cafe"
        token = "TokEnCafe"
        comment = "DoulorCloud | disabled"
        ports = [31500]
        domains = [""]
        subdomains = [""]
        enable = false
"""

results = []


def check(name, got, want):
    ok = got == want
    results.append(ok)
    print("  %s %-44s 期望 %-22s 实际 %s" % ("✓" if ok else "✗", name, want, got))


tmp = tempfile.mkdtemp(prefix="legacy-import-")
try:
    src = os.path.join(tmp, "frps-tokens.toml")
    dst = os.path.join(tmp, "accounts.json")
    with open(src, "w", encoding="utf-8") as fh:
        fh.write(LEGACY)

    panel.CONFIG["user_prefix"] = "dcfrp_"
    store = panel.Store(dst)
    imported, why = panel.import_legacy_toml(src, store, only_managed=True)
    print("迁移结果：%s" % why)
    print("")

    accounts = {a["user"]: a for a in store.all()}

    print("=== 安全边界：只接管 dcfrp_ 前缀 ===")
    check("导入数量", imported, 2)
    check("历史账号 123 未被导入", "123" in accounts, False)
    check("历史账号 AOS 未被导入", "AOS" in accounts, False)
    check("dcfrp_deadbeef 已导入", "dcfrp_deadbeef" in accounts, True)
    check("dcfrp_cafe 已导入", "dcfrp_cafe" in accounts, True)

    print("")
    print("=== 端口解析（含区间展开）===")
    check("显式端口 + 区间展开",
          accounts["dcfrp_deadbeef"]["ports"], [31000, 31001, 31200, 31201, 31202])
    check("单端口", accounts["dcfrp_cafe"]["ports"], [31500])

    print("")
    print("=== 到期日从 comment 抽出 ===")
    check("expire_at", accounts["dcfrp_deadbeef"]["expire_at"], "2026-11-12T23:59:59Z")

    print("")
    print("=== 令牌与 enable 保真 ===")
    check("token", accounts["dcfrp_deadbeef"]["token"], "TokEnDeadBeef")
    check("enable=false 保留", accounts["dcfrp_cafe"]["enable"], False)
    check("comment 保留",
          accounts["dcfrp_deadbeef"]["comment"], "DoulorCloud | active | 到期 2026-11-12")

    print("")
    print("=== 导入全部（切换时必须用 --import-all）===")
    # 🔴 这一节是「切换会让 46 个用户掉线」那个坑的回归测试。
    #
    #   「导入」和「可管理」是两件事：
    #     · 插件是**按账号名查表**授权的 → 历史账号必须在 store 里，
    #       否则它们登录时插件回「账号不存在」，全体掉线。
    #     · 自动化能不能改它 → 另一回事，由 is_managed() 把关。
    #   之前我把这两件事混了，切换脚本只导入了 dcfrp_ 前缀 —— 那会踢掉 46 个用户。
    dst2 = os.path.join(tmp, "accounts-all.json")
    store2 = panel.Store(dst2)
    imported_all, _ = panel.import_legacy_toml(src, store2, only_managed=False)
    all_accounts = {a["user"]: a for a in store2.all()}

    check("导入数量（含历史账号）", imported_all, 4)
    check("历史账号 123 已导入", "123" in all_accounts, True)
    check("历史账号 AOS 已导入", "AOS" in all_accounts, True)
    check("dcfrp_ 账号也在", "dcfrp_deadbeef" in all_accounts, True)

    print("")
    print("=== 导入后：历史账号能被插件授权（它们必须照常能用）===")
    ok, why = panel.check_account(all_accounts["123"], "741852963")
    check("历史账号凭正确令牌 -> 放行", ok, True)
    ok_bad, why_bad = panel.check_account(all_accounts["123"], "wrong-token")
    check("历史账号凭错误令牌 -> 拒绝", ok_bad, False)
    # 顺带验证：区间的历史账号端口也正确展开
    check("历史账号区间端口展开", all_accounts["AOS"]["ports"], [28888, 28889, 28890])

    print("")
    print("=== 但自动化仍然碰不到历史账号（写入边界不受导入范围影响）===")
    panel.CONFIG["user_prefix"] = "dcfrp_"
    check("is_managed('123') = False", panel.is_managed("123"), False)
    check("is_managed('AOS') = False", panel.is_managed("AOS"), False)
    check("is_managed('dcfrp_deadbeef') = True", panel.is_managed("dcfrp_deadbeef"), True)

    print("")
    failed = results.count(False)
    print("结果：%d 个用例，%d 个失败" % (len(results), failed))
finally:
    shutil.rmtree(tmp, ignore_errors=True)

sys.exit(1 if results.count(False) else 0)
