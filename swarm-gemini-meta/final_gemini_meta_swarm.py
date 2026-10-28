#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""final_gemini_meta_swarm.py - سكربت السرب (Gemini + Meta Llama) بعد إصلاح الثغرتين الأمنيتين.

الإصلاحات في هذه النسخة مقارنة بنسخة السرب السابقة:
1) الأمان:
   - لا يُنفَّذ أي كود مولَّد داخل العملية الرئيسية (لا exec_module ولا import).
   - التشغيل يتم في عملية فرعية معزولة بمهلة زمنية.
   - لا تشغيل إلا بعد موافقة صريحة من المستخدم، والافتراضي رفض.
   - لا يوجد متغير بيئة يلغي التأكيد (تم حذف SWARM_AUTORUN نهائيًا).
   - فحص AST موسّع: منع استيراد os و subprocess و importlib و ctypes و pty و shutil،
     ومنع eval/exec/compile/__import__، ومنع getattr على builtins أو بأسماء مزدوجة
     الشرطة السفلية، ومنع open() للكتابة أو بمسار خارج مجلد العمل.
2) الـ Mock:
   - لا رجوع صامتًا إلى Mock عند فشل نموذج حقيقي أو غياب المفتاح: يفشل البرنامج برسالة واضحة.
   - وضع mock يعمل فقط إذا اختير صراحةً.
   - كل مخرجات Mock موسومة بـ [MOCK]، ولا تُحفظ في ذاكرة الوكلاء، ولا تُعَد نتيجة اختبار ناجحة.

الأوضاع (SWARM_MODE): mock | gemini | meta | hybrid  (يجب تحديد الوضع صراحةً عند التشغيل)
متغيرات البيئة:
  GEMINI_API_KEY, GEMINI_MODEL (افتراضي gemini-2.0-flash - راجع الاسم الحالي)
  META_API_KEY أو TOGETHER_API_KEY أو GROQ_API_KEY
  META_MODEL, META_BASE_URL (لتغيير نموذج Llama أو المزود)
  SWARM_WORKSPACE (مجلد العمل، الافتراضي swarm_gemini_meta_workspace)
"""
import ast
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

import requests

VALID_MODES = ("mock", "gemini", "meta", "hybrid")
MOCK_TAG = "[MOCK]"
WORKSPACE = Path(os.environ.get("SWARM_WORKSPACE", "swarm_gemini_meta_workspace")).resolve()


# ---------- أدوات صغيرة ----------
def jload(path, default):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default
    except (OSError, ValueError) as e:
        print(f"! JSON read error {path}: {type(e).__name__}: {e}")
        return default


def jsave(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


ROLES = {
    "Architect": "You are the Architect. Break the task into a short numbered plan (max 6 steps) and name the Python function the tool needs.",
    "Researcher": "You are the Researcher. List the Python libraries and public APIs best suited to the plan. Prefer the standard library. Never invent URLs.",
    "Coder": "You are the Coder. Reply with ONE complete Python 3 script inside a ```python block. Use the standard library and requests only. It must define run() and print(run()) when executed as __main__. Never delete files; never use subprocess, os, eval, exec, importlib or getattr.",
    "Tester": "You are the Tester. Review the code for bugs and safety problems. First line must be PASS or FAIL, then at most 5 short lines of reasons.",
    "Evolver": "You are the Evolver. In one short paragraph say what worked, what failed, and one concrete improvement for next time.",
}


# ---------- النماذج ----------
def _mock(kind):
    """ردود وهمية موسومة صراحةً بـ [MOCK] - لا تُحفظ ولا تُعَد نجاحًا."""
    if kind == "code":
        return (f"{MOCK_TAG} ```python\n# generated in MOCK mode - not a real model output\n"
                "def run():\n    return 'mock tool is working'\n\n"
                "if __name__ == '__main__':\n    print(run())\n```")
    return {
        "plan": f"{MOCK_TAG} mock plan: NOT a real plan.\n1. Understand the goal\n2. Pick libraries\n3. Write run()\n4. Test it",
        "review": f"{MOCK_TAG} mock review: NOT a real verdict. Syntax and safety patterns checked only.",
        "evolve": f"{MOCK_TAG} mock evolve: Verify output before answering.\nKeep answers short.\nReuse existing tools when possible.",
    }.get(kind, f"{MOCK_TAG} mock notes: prefer the standard library first.")


def _gemini(system, prompt):
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError("مفتاح GEMINI_API_KEY غير مضبوط - لا يمكن تشغيل وضع gemini بدون مفتاح")
    model = os.environ.get("GEMINI_MODEL", "gemini-2.0-flash")
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    r = requests.post(
        url,
        headers={"x-goog-api-key": api_key, "Content-Type": "application/json"},
        json={"system_instruction": {"parts": [{"text": system}]},
              "contents": [{"parts": [{"text": prompt}]}]},
        timeout=120,
    )
    r.raise_for_status()
    return r.json()["candidates"][0]["content"]["parts"][0]["text"]


def _meta(system, prompt):
    env = os.environ
    if env.get("META_API_KEY") or env.get("TOGETHER_API_KEY"):
        key = env.get("META_API_KEY") or env["TOGETHER_API_KEY"]
        base, model = "https://api.together.xyz/v1", "meta-llama/Llama-3.3-70B-Instruct-Turbo"
    elif env.get("GROQ_API_KEY"):
        key = env["GROQ_API_KEY"]
        base, model = "https://api.groq.com/openai/v1", "llama-3.3-70b-versatile"
    else:
        raise RuntimeError("مفتاح META_API_KEY أو TOGETHER_API_KEY أو GROQ_API_KEY غير مضبوط - لا يمكن تشغيل وضع meta بدون مفتاح")
    base = env.get("META_BASE_URL", base)
    model = env.get("META_MODEL", model)
    r = requests.post(
        f"{base}/chat/completions",
        headers={"Authorization": f"Bearer {key}"},
        json={"model": model,
              "messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}]},
        timeout=120,
    )
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"]


class Router:
    """يوجّه الطلبات إلى النموذج المناسب. لا رجوع صامتًا إلى Mock إطلاقًا."""

    def __init__(self, mode=None):
        env = os.environ
        self.has = {
            "gemini": bool(env.get("GEMINI_API_KEY")),
            "meta": bool(env.get("META_API_KEY") or env.get("TOGETHER_API_KEY") or env.get("GROQ_API_KEY")),
        }
        chosen = (mode or env.get("SWARM_MODE") or "").strip().lower()
        if not chosen:
            raise RuntimeError("SWARM_MODE غير محدد. حدد الوضع صراحةً عند التشغيل: mock أو gemini أو meta أو hybrid")
        if chosen not in VALID_MODES:
            raise RuntimeError(f"وضع غير معروف: {chosen}. الأوضاع المسموحة: {', '.join(VALID_MODES)}")
        if chosen in ("gemini", "meta") and not self.has[chosen]:
            missing = "GEMINI_API_KEY" if chosen == "gemini" else "META_API_KEY/TOGETHER_API_KEY/GROQ_API_KEY"
            raise RuntimeError(f"وضع {chosen} يحتاج مفتاحًا ولم يتم ضبطه ({missing}). لا رجوع صامتًا إلى mock")
        if chosen == "hybrid" and not any(self.has.values()):
            raise RuntimeError("الوضع hybrid يحتاج مفتاح GEMINI_API_KEY أو META_API_KEY/TOGETHER_API_KEY/GROQ_API_KEY على الأقل، ولم يُضبط أي مفتاح")
        self.mode = chosen
        print(f"الوضع الحالي: {self.mode}")

    def pick(self, kind):
        pref = "meta" if kind == "code" else "gemini"
        if self.has[pref]:
            return pref
        other = "gemini" if pref == "meta" else "meta"
        if self.has[other]:
            return other
        raise RuntimeError("لا يوجد نموذج حقيقي متاح في الوضع hybrid")

    def _backends_for(self, kind):
        """ترتيب النماذج المسموح بتجربتها. في hybrid يجرب النموذج المفضل ثم الآخر. لا Mock أبدًا."""
        if self.mode != "hybrid":
            return [self.mode]
        first = self.pick(kind)
        second = "gemini" if first == "meta" else "meta"
        return [first, second] if self.has[second] else [first]

    def ask(self, kind, system, prompt):
        if self.mode == "mock":
            return _mock(kind)
        problems = []
        for backend in self._backends_for(kind):
            try:
                if backend == "gemini":
                    return _gemini(system, prompt)
                return _meta(system, prompt)
            except Exception as e:
                problems.append(f"{backend}: {type(e).__name__}: {e}")
        # لا رجوع صامتًا إلى Mock: فشل واضح برسالة صريحة
        raise RuntimeError(f"فشل النموذج ({'; '.join(problems)}) ولم يتم الرجوع إلى Mock")


# ---------- فحص أمان الكود المولَّد ----------
# ملاحظة: الفحص طبقة أمان أولى وليس sandbox كاملًا. الحماية الأساسية هي:
# موافقة صريحة قبل التشغيل + تشغيل معزول في عملية فرعية بمهلة زمنية.
BANNED_MODULES = {"os", "subprocess", "importlib", "ctypes", "pty", "shutil"}
BANNED_CALLS = {"eval", "exec", "compile", "__import__"}
BANNED_METHODS = {"system", "popen", "remove", "rmdir", "unlink", "rmtree",
                  "write_text", "write_bytes", "open"}
_DUNDER = re.compile(r"^__.+__$")


def _name(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        left = _name(node.value)
        return f"{left}.{node.attr}" if left else node.attr
    return ""


def _check_open_call(n, workspace):
    """open() مسموح للقراءة فقط، وبمسار نصي ثابت داخل مجلد العمل."""
    mode_arg = n.args[1] if len(n.args) > 1 else next(
        (k.value for k in n.keywords if k.arg == "mode"), None)
    mode = mode_arg.value if isinstance(mode_arg, ast.Constant) and isinstance(mode_arg.value, str) else "r"
    if set("wax+") & set(mode):
        return "open() للكتابة ممنوع في الأدوات المولَّدة"
    path_arg = n.args[0] if n.args else next((k.value for k in n.keywords if k.arg == "file"), None)
    if not (isinstance(path_arg, ast.Constant) and isinstance(path_arg.value, str)):
        return "open() يُسمح به فقط بمسار نصي ثابت داخل مجلد العمل"
    target = (workspace / path_arg.value).resolve()
    if target != workspace and workspace not in target.parents:
        return f"open() خارج مجلد العمل ممنوع: {path_arg.value}"
    return None


def check_code(code, workspace=None):
    """يرجع نص المشكلة الأمنية أو None لو الكود سليم."""
    ws = (workspace or WORKSPACE).resolve()
    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        return f"syntax error: {e}"
    errors, bad_names = [], set()
    if not any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == "run" for n in tree.body):
        errors.append("missing run() function")
    for n in ast.walk(tree):
        if isinstance(n, ast.Import):
            for a in n.names:
                root = a.name.split(".")[0]
                if root in BANNED_MODULES:
                    errors.append(f"blocked import: {a.name}")
                    bad_names.add(a.asname or root)
        elif isinstance(n, ast.ImportFrom):
            mod = (n.module or "").split(".")[0]
            for a in n.names:
                if mod in BANNED_MODULES:
                    errors.append(f"blocked import: from {n.module} import {a.name}")
                    bad_names.add(a.asname or a.name)
        elif isinstance(n, ast.Attribute):
            if _DUNDER.match(n.attr):
                errors.append(f"blocked dunder access: .{n.attr}")
    for n in ast.walk(tree):
        if not isinstance(n, ast.Call):
            continue
        name = _name(n.func)
        if name in BANNED_CALLS or (name and name.split(".")[0] in bad_names):
            errors.append(f"blocked call: {name}")
        if name == "open" or (isinstance(n.func, ast.Attribute) and n.func.attr == "open"):
            problem = _check_open_call(n, ws)
            if problem:
                errors.append(problem)
        if name == "getattr":
            obj = n.args[0] if n.args else next((k.value for k in n.keywords if k.arg == "object"), None)
            attr = n.args[1] if len(n.args) > 1 else next((k.value for k in n.keywords if k.arg == "name"), None)
            obj_txt = obj.value if isinstance(obj, ast.Constant) else _name(obj) if obj is not None else ""
            attr_txt = attr.value if isinstance(attr, ast.Constant) else (_name(attr) if attr is not None else "")
            if "builtins" in str(obj_txt) or (attr_txt and _DUNDER.match(str(attr_txt))):
                errors.append(f"blocked getattr: {name}({obj_txt}, {attr_txt!r})")
    return "; ".join(dict.fromkeys(errors)) or None


def extract_code(text):
    m = re.search(r"```(?:python)?\s*\n(.*?)```", text, re.S | re.I)
    return (m.group(1) if m else text).strip()


def confirm_execution(tool_name):
    """تأكيد تفاعلي قبل تشغيل أي كود مولَّد. الافتراضي رفض، ولا يوجد متغير بيئة يلغيه."""
    try:
        answer = input(f"   تشغيل {tool_name}؟ اكتب y للتأكيد (أي شيء آخر = رفض): ").strip().lower()
    except (EOFError, OSError):
        return False
    return answer in ("y", "yes")


def run_tool(path, confirm=None, timeout=30):
    """يشغّل الأداة في عملية فرعية معزولة بعد موافقة صريحة فقط."""
    path = Path(path)
    if confirm is None:
        confirm = confirm_execution
    if not confirm(path.name):
        return "(لم يتم التشغيل: رفض المستخدم أو غياب تأكيد صريح)"
    try:
        r = subprocess.run([sys.executable, "-I", str(path)],
                            capture_output=True, text=True, timeout=timeout)
        return (r.stdout or r.stderr).strip()[:500] or "(بدون مخرجات)"
    except subprocess.TimeoutExpired:
        return f"(انتهت المهلة {timeout} ثانية بدون نتيجة)"
    except Exception as e:
        return f"execution error: {type(e).__name__}: {e}"[:500]


def save_tool(ws, task, code):
    reg_path = ws / "tools" / "registry.json"
    reg = jload(reg_path, [])
    path = ws / "tools" / f"tool_{len(reg) + 1:03d}.py"
    path.write_text(code + "\n", encoding="utf-8")
    reg.append({"file": path.name, "task": task, "time": time.strftime("%Y-%m-%d %H:%M")})
    jsave(reg_path, reg)
    return path


# ---------- المساعد ----------
class Agent:
    def __init__(self, name, role, router, ws, evolve_every=3):
        self.name, self.role, self.router, self.evolve_every = name, role, router, evolve_every
        self.path = Path(ws) / "memory" / f"{name}.json"
        self.mem = jload(self.path, {"version": 1.0, "lessons": "", "history": [], "done": 0})

    @property
    def system(self):
        extra = f"\nLessons learned:\n{self.mem['lessons']}" if self.mem["lessons"] else ""
        return self.role + extra

    def work(self, kind, prompt):
        out = self.router.ask(kind, self.system, prompt)
        if self.router.mode == "mock":
            # مخرجات الـ Mock موسومة بـ [MOCK] ولا تُحفظ في ذاكرة الوكيل
            print(f"   {MOCK_TAG} {self.name}: وضع mock - لم تُحفظ المخرجات في الذاكرة")
            return out
        entry = {"time": time.strftime("%Y-%m-%d %H:%M"), "in": prompt[:120], "out": out[:200]}
        self.mem["history"] = (self.mem["history"] + [entry])[-20:]
        self.mem["done"] += 1
        if self.mem["done"] % self.evolve_every == 0:
            self.evolve()
        jsave(self.path, self.mem)
        return out

    def evolve(self):
        recent = "\n".join(f"- {h['in']} => {h['out']}" for h in self.mem["history"][-3:])
        new = self.router.ask(
            "evolve", "You improve AI agent instructions.",
            f"Role: {self.role}\nCurrent lessons: {self.mem['lessons']}\nRecent work:\n{recent}\n"
            "Write the updated lessons, at most 5 short lines, nothing else.")
        if new.strip() and not new.startswith(MOCK_TAG):
            # الدور الأساسي ثابت، والتطور يحدث في الدروس فقط (يمنع انحراف الوكيل).
            self.mem["lessons"] = new.strip()[:800]
            self.mem["version"] = round(self.mem["version"] + 0.1, 1)
            print(f"   ↑ {self.name} -> v{self.mem['version']}")


# ---------- السرب ----------
class Swarm:
    def __init__(self, workspace, agents=("Architect", "Researcher", "Coder", "Tester", "Evolver"), mode=None):
        self.ws = Path(workspace)
        (self.ws / "tools").mkdir(parents=True, exist_ok=True)
        (self.ws / "memory").mkdir(parents=True, exist_ok=True)
        self.router = Router(mode)
        self.agents = {n: Agent(n, ROLES[n], self.router, self.ws) for n in agents}
        self.board_path = self.ws / "blackboard.json"
        self.ver_path = self.ws / "version.json"
        self.board = jload(self.board_path, [])
        self.state = jload(self.ver_path, {"swarm_version": 1.0, "tasks_done": 0})
        self.results = []

    def post(self, who, content):
        self.board = (self.board + [{"from": who, "time": time.strftime("%H:%M:%S"), "content": content[:500]}])[-50:]
        jsave(self.board_path, self.board)

    def step(self, name, kind, prompt, default=""):
        agent = self.agents.get(name)
        if not agent:
            return default
        print(f"   • {name}...")
        out = agent.work(kind, prompt)
        self.post(name, out)
        return out

    def run_one(self, task):
        print(f"\n=== المهمة: {task}")
        is_mock = self.router.mode == "mock"
        plan = self.step("Architect", "plan", f"Task: {task}")
        notes = self.step("Researcher", "text", f"Task: {task}\nPlan:\n{plan}")
        ctx = f"Task: {task}\nPlan:\n{plan}\nNotes:\n{notes}"
        code = extract_code(self.step("Coder", "code", ctx))
        problem = check_code(code, workspace=self.ws)
        if problem:  # محاولة تصحيح واحدة فقط
            code = extract_code(self.step("Coder", "code", ctx + f"\nYour previous code was rejected: {problem}. Fix it."))
            problem = check_code(code, workspace=self.ws)

        if is_mock:
            # في وضع mock: لا حفظ للأداة ولا تشغيل، والنتيجة موسومة ولا تُعَد نجاحًا
            review = self.step("Tester", "review", f"Task: {task}\nCode:\n{code}")
            status, fname, out = f"{MOCK_TAG} تجاهلت نتيجة المختبر ولم تُحفظ الأداة (وضع mock)", "", ""
        elif problem:
            review, fname, out = "PASS (no tester)", "", ""
            status = f"rejected: {problem}"
        else:
            review = self.step("Tester", "review", f"Task: {task}\nCode:\n{code}")
            if review.strip().upper().startswith(MOCK_TAG):
                status, fname, out = "rejected: tester output is MOCK", "", ""
            elif review.strip().upper().startswith("PASS"):
                path = save_tool(self.ws, task, code)
                fname, status = path.name, "saved"
                out = run_tool(path)
            else:
                status = "failed review"
        self.step("Evolver", "text", f"Task: {task}\nStatus: {status}\nReview: {review[:200]}\nOutput: {out[:200]}")
        print(f"   النتيجة: {status} {fname} {out[:80]}")
        self.results.append({"task": task, "status": status, "tool": fname, "output": out})

        if not is_mock:
            self.state["tasks_done"] += 1
            if self.state["tasks_done"] % 3 == 0:
                self.state["swarm_version"] = round(self.state["swarm_version"] + 0.1, 1)
                print(f"   ↑ السرب -> v{self.state['swarm_version']}")
            jsave(self.ver_path, self.state)

    def run(self, tasks):
        for t in tasks:
            self.run_one(t)
        lines = ["# نتائج التشغيل\n"]
        for r in self.results:
            lines.append(f"- **{r['task']}** -> {r['status']} {r['tool']}\n  output: {r['output']}")
        (self.ws / "RESULTS.md").write_text("\n".join(lines), encoding="utf-8")
        print(f"\nتم. الملفات في: {self.ws}/  (RESULTS.md, tools/, memory/, blackboard.json)")


# ---------- التشغيل ----------
# python final_gemini_meta_swarm.py "مهمتك هنا" "مهمة تانية"        (يتطلب SWARM_MODE)
# python final_gemini_meta_swarm.py --single "مهمة"                  -> مساعد واحد فقط (Coder)
DEFAULT_TASKS = [
    "بناء أداة تجيب سعر الدولار",
    "بناء أداة تلخيص نصوص",
    "بناء نظام تقارير يومية",
]

if __name__ == "__main__":
    args = sys.argv[1:]
    single = "--single" in args
    tasks = [a for a in args if a != "--single"] or DEFAULT_TASKS
    try:
        swarm = Swarm(WORKSPACE, agents=("Coder",) if single else ("Architect", "Researcher", "Coder", "Tester", "Evolver"))
    except RuntimeError as e:
        print(f"\n[خطأ] {e}", file=sys.stderr)
        sys.exit(2)
    swarm.run(tasks)
