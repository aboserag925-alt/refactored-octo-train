"""swarm_final.py - الملف النهائي الكامل (محرك + سرب + تشغيل).

الأوضاع (SWARM_MODE): mock (افتراضي، بدون مفاتيح) | gemini | meta | hybrid
متغيرات البيئة:
  GEMINI_API_KEY, GEMINI_MODEL (افتراضي gemini-2.0-flash - راجع الاسم الحالي)
  META_API_KEY أو TOGETHER_API_KEY أو GROQ_API_KEY
  META_MODEL, META_BASE_URL (لتغيير نموذج Llama أو المزود)
  SWARM_AUTORUN=1  لتشغيل الأدوات المكتوبة تلقائيا بدون سؤال (غير مفضل)
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
    "Coder": "You are the Coder. Reply with ONE complete Python 3 script inside a ```python block. Use the standard library and requests only. It must define run() and print(run()) when executed as __main__. Never delete files; never use subprocess, os.system, eval or exec.",
    "Tester": "You are the Tester. Review the code for bugs and safety problems. First line must be PASS or FAIL, then at most 5 short lines of reasons.",
    "Evolver": "You are the Evolver. In one short paragraph say what worked, what failed, and one concrete improvement for next time.",
}


# ---------- النماذج ----------
def _mock(kind):
    if kind == "code":
        return ("```python\n# generated in MOCK mode\ndef run():\n    return 'mock tool is working'\n\n"
                "if __name__ == '__main__':\n    print(run())\n```")
    return {
        "plan": "1. Understand the goal\n2. Pick libraries\n3. Write run()\n4. Test it",
        "review": "PASS\nMock review: syntax and safety patterns checked only.",
        "evolve": "Verify output before answering.\nKeep answers short.\nReuse existing tools when possible.",
    }.get(kind, "Mock notes: prefer the standard library first.")


def _gemini(system, prompt):
    model = os.environ.get("GEMINI_MODEL", "gemini-2.0-flash")
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    r = requests.post(
        url,
        headers={"x-goog-api-key": os.environ["GEMINI_API_KEY"], "Content-Type": "application/json"},
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
    else:
        key = env["GROQ_API_KEY"]
        base, model = "https://api.groq.com/openai/v1", "llama-3.3-70b-versatile"
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
    def __init__(self, mode=None):
        env = os.environ
        self.has = {
            "gemini": bool(env.get("GEMINI_API_KEY")),
            "meta": bool(env.get("META_API_KEY") or env.get("TOGETHER_API_KEY") or env.get("GROQ_API_KEY")),
        }
        self.mode = (mode or env.get("SWARM_MODE", "mock")).lower()
        if self.mode not in ("mock", "gemini", "meta", "hybrid"):
            print(f"! وضع غير معروف {self.mode} -> mock")
            self.mode = "mock"
        if self.mode in ("gemini", "meta") and not self.has[self.mode]:
            print(f"! مفتاح {self.mode} مش موجود -> رجعت لوضع mock")
            self.mode = "mock"
        if self.mode == "hybrid" and not any(self.has.values()):
            print("! مفيش مفاتيح -> رجعت لوضع mock")
            self.mode = "mock"
        print(f"الوضع الحالي: {self.mode}")

    def pick(self, kind):
        if self.mode != "hybrid":
            return self.mode
        pref = "meta" if kind == "code" else "gemini"
        if self.has[pref]:
            return pref
        return "gemini" if self.has["gemini"] else "meta"

    def ask(self, kind, system, prompt):
        backend = self.pick(kind)
        try:
            if backend == "gemini":
                return _gemini(system, prompt)
            if backend == "meta":
                return _meta(system, prompt)
        except Exception as e:  # شبكة، مفتاح غلط، حد استخدام...
            print(f"   ! {backend} فشل ({type(e).__name__}) -> mock")
        return _mock(kind)


# ---------- الأدوات المكتوبة ----------
# تنبيه: الفحص ده طبقة أمان مش sandbox كامل. الحماية الفعلية هي سؤال y/n قبل التشغيل.
BANNED_MODULES = {"subprocess", "ctypes", "pty"}
BANNED_CALLS = {"eval", "exec", "compile", "__import__", "os.system", "os.popen",
                "os.remove", "os.rmdir", "os.unlink", "shutil.rmtree"}
BANNED_FROM = {"os": {"system", "popen", "remove", "rmdir", "unlink"}, "shutil": {"rmtree"}}
BANNED_METHODS = {"write_text", "write_bytes", "unlink", "rmdir", "rmtree"}


def extract_code(text):
    m = re.search(r"```(?:python)?\s*\n(.*?)```", text, re.S | re.I)
    return (m.group(1) if m else text).strip()


def _name(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        left = _name(node.value)
        return f"{left}.{node.attr}" if left else node.attr
    return ""


def check_code(code):
    """يرجع نص المشكلة، أو None لو الكود سليم."""
    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        return f"syntax error: {e}"
    errors, bad_names = [], set()
    if not any(isinstance(n, ast.FunctionDef) and n.name == "run" for n in tree.body):
        errors.append("missing synchronous run() function")
    for n in ast.walk(tree):
        if isinstance(n, ast.Import):
            for a in n.names:
                if a.name.split(".")[0] in BANNED_MODULES:
                    errors.append(f"blocked import: {a.name}")
                    bad_names.add(a.asname or a.name.split(".")[0])
        elif isinstance(n, ast.ImportFrom):
            mod = n.module or ""
            for a in n.names:
                if mod.split(".")[0] in BANNED_MODULES or a.name in BANNED_FROM.get(mod, ()):
                    errors.append(f"blocked import: from {mod} import {a.name}")
                    bad_names.add(a.asname or a.name)
    for n in ast.walk(tree):
        if not isinstance(n, ast.Call):
            continue
        name = _name(n.func)
        if name in BANNED_CALLS or (name and name.split(".")[0] in bad_names):
            errors.append(f"blocked call: {name}")
        if isinstance(n.func, ast.Attribute) and n.func.attr in BANNED_METHODS:
            errors.append(f"blocked method: {n.func.attr}")
        if name == "open":
            mode = n.args[1] if len(n.args) > 1 else next(
                (k.value for k in n.keywords if k.arg == "mode"), None)
            if isinstance(mode, ast.Constant) and isinstance(mode.value, str) and set("wax+") & set(mode.value):
                errors.append("blocked: open() for writing")
    return "; ".join(dict.fromkeys(errors)) or None


def save_tool(ws, task, code):
    reg_path = ws / "tools" / "registry.json"
    reg = jload(reg_path, [])
    path = ws / "tools" / f"tool_{len(reg) + 1:03d}.py"
    path.write_text(code + "\n", encoding="utf-8")
    reg.append({"file": path.name, "task": task, "time": time.strftime("%Y-%m-%d %H:%M")})
    jsave(reg_path, reg)
    return path


def run_tool(path):
    if os.environ.get("SWARM_AUTORUN") != "1":
        try:
            ok = input(f"   تشغيل {path.name}؟ (y/n): ").strip().lower() == "y"
        except EOFError:
            ok = False
        if not ok:
            return "(لم يتم التشغيل)"
    try:
        r = subprocess.run([sys.executable, path.name], cwd=path.parent,
                           capture_output=True, text=True, timeout=20)
        return (r.stdout or r.stderr).strip()[:500]
    except subprocess.TimeoutExpired:
        return "timeout"
    except Exception as e:
        return f"execution error: {type(e).__name__}: {e}"[:500]


# ---------- المساعد ----------
class Agent:
    def __init__(self, name, role, router, ws, evolve_every=3):
        self.name, self.role, self.router, self.evolve_every = name, role, router, evolve_every
        self.path = ws / "memory" / f"{name}.json"
        self.mem = jload(self.path, {"version": 1.0, "lessons": "", "history": [], "done": 0})

    @property
    def system(self):
        extra = f"\nLessons learned:\n{self.mem['lessons']}" if self.mem["lessons"] else ""
        return self.role + extra

    def work(self, kind, prompt):
        out = self.router.ask(kind, self.system, prompt)
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
        if new.strip():
            # الدور الأساسي ثابت، والتطور بيحصل في الدروس فقط (يمنع انحراف الأجنت).
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
        plan = self.step("Architect", "plan", f"Task: {task}")
        notes = self.step("Researcher", "text", f"Task: {task}\nPlan:\n{plan}")
        ctx = f"Task: {task}\nPlan:\n{plan}\nNotes:\n{notes}"
        code = extract_code(self.step("Coder", "code", ctx))
        problem = check_code(code)
        if problem:  # محاولة تصحيح واحدة
            code = extract_code(self.step("Coder", "code", ctx + f"\nYour previous code was rejected: {problem}. Fix it."))
            problem = check_code(code)

        review, out, fname = "PASS (no tester)", "", ""
        status = f"rejected: {problem}" if problem else ""
        if not problem:
            review = self.step("Tester", "review", f"Task: {task}\nCode:\n{code}", review)
            if review.strip().upper().startswith("PASS"):
                path = save_tool(self.ws, task, code)
                fname, status = path.name, "saved"
                out = run_tool(path)
            else:
                status = "failed review"
        self.step("Evolver", "text", f"Task: {task}\nStatus: {status}\nReview: {review[:200]}\nOutput: {out[:200]}")
        print(f"   النتيجة: {status} {fname} {out[:80]}")
        self.results.append({"task": task, "status": status, "tool": fname, "output": out})

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
# python swarm_all_in_one.py                      -> السرب الكامل بمهام افتراضية
# python swarm_all_in_one.py "مهمتك هنا" "مهمة تانية"
# python swarm_all_in_one.py --single "مهمة"       -> مساعد واحد فقط (Coder)
DEFAULT_TASKS = [
    "بناء أداة تجيب سعر الدولار",
    "بناء أداة تلخيص نصوص",
    "بناء نظام تقارير يومية",
]

if __name__ == "__main__":
    args = sys.argv[1:]
    single = "--single" in args
    tasks = [a for a in args if a != "--single"] or DEFAULT_TASKS
    ws = os.environ.get("SWARM_WORKSPACE", "swarm_final_workspace")
    Swarm(ws, agents=("Coder",) if single else ("Architect", "Researcher", "Coder", "Tester", "Evolver")).run(tasks)

