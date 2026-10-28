"""swarm_security.py - طبقة الأمان لسرب swarm.finaly.py.

1) check_code: فحص AST بقائمة سماح (كل ما ليس مسموحا به مرفوض).
2) autorun_enabled: التأكيد قبل التشغيل هو الافتراضي.
تنبيه: هذه طبقة دفاع وليست sandbox. التشغيل داخل حاوية معزولة (SWARM_SECURITY_AR.md) ضروري.
"""
import ast
import os
import sys

AUTORUN_VAR = "SWARM_AUTORUN_I_UNDERSTAND_THE_RISK"

# وحدات آمنة نسبيا لأداة صغيرة. أي وحدة غيرها مرفوضة (os, sys, pathlib, importlib, subprocess, socket, shutil...).
ALLOWED_MODULES = {
    "json", "re", "math", "datetime", "time", "random", "statistics", "collections",
    "itertools", "functools", "string", "textwrap", "decimal", "fractions", "typing",
    "html", "base64", "hashlib", "urllib.parse", "requests",
}
# دوال مدمجة ممنوعة. open ممنوعة كليا (الأدوات لا تحتاج ملفات).
BANNED_NAMES = {
    "eval", "exec", "compile", "__import__", "open", "input", "breakpoint", "getattr",
    "setattr", "delattr", "globals", "locals", "vars", "dir", "memoryview", "help",
    "exit", "quit", "__builtins__", "__loader__", "__spec__",
}
# سمات ممنوعة على أي كائن (دفاع إضافي).
BANNED_ATTRS = {
    "open", "read_text", "read_bytes", "write_text", "write_bytes", "unlink", "rmdir",
    "rmtree", "system", "popen", "import_module", "mkdir", "rename", "replace",
    "remove", "removedirs", "chmod", "chown", "symlink_to", "touch",
}


def _module_allowed(name):
    return name in ALLOWED_MODULES or name.split(".")[0] in {
        m for m in ALLOWED_MODULES if "." not in m
    }


def check_code(code):
    """يرجع نص المشكلة، أو None لو الكود مسموح."""
    try:
        tree = ast.parse(code)
    except (SyntaxError, ValueError) as e:
        return f"syntax error: {e}"
    errors = []
    if not any(isinstance(n, ast.FunctionDef) and n.name == "run" for n in tree.body):
        errors.append("missing synchronous run() function")
    for n in ast.walk(tree):
        if isinstance(n, ast.Import):
            for a in n.names:
                if not _module_allowed(a.name):
                    errors.append(f"import not in allowlist: {a.name}")
        elif isinstance(n, ast.ImportFrom):
            if n.level or not n.module or not _module_allowed(n.module):
                errors.append(f"import not in allowlist: from {'.' * n.level}{n.module or ''}")
            elif n.module.startswith("urllib") and n.module != "urllib.parse":
                errors.append(f"import not in allowlist: from {n.module}")
        elif isinstance(n, ast.Name):
            if n.id in BANNED_NAMES or (n.id.startswith("__") and n.id.endswith("__")
                                        and n.id != "__name__"):
                errors.append(f"blocked name: {n.id}")
        elif isinstance(n, ast.Attribute):
            if n.attr in BANNED_ATTRS:
                errors.append(f"blocked attribute: {n.attr}")
            elif n.attr.startswith("__"):
                errors.append(f"blocked dunder attribute: {n.attr}")
        elif isinstance(n, (ast.Global, ast.Nonlocal)):
            errors.append("global/nonlocal not allowed")
    return "; ".join(dict.fromkeys(errors)) or None


def autorun_enabled(env=None):
    """التأكيد y/n هو الافتراضي. لا يُلغى إلا بالمتغير الصريح الطويل."""
    env = os.environ if env is None else env
    if env.get("SWARM_AUTORUN") == "1":
        print("! SWARM_AUTORUN=1 لم يعد يلغي التأكيد. للإلغاء (خطر) استخدم "
              f"{AUTORUN_VAR}=yes داخل حاوية معزولة فقط.", file=sys.stderr)
    if env.get(AUTORUN_VAR) == "yes":
        print("!!! تحذير: التشغيل التلقائي مفعّل. الكود المولّد سيعمل بدون تأكيد.", file=sys.stderr)
        return True
    return False
