"""swarm_final.py - الملف النهائي الكامل (محرك + سرب + تشغيل).

الأوضاع (SWARM_MODE): mock (افتراضي، بدون مفاتيح) | gemini | meta | hybrid
متغيرات البيئة:
  GEMINI_API_KEY, GEMINI_MODEL (افتراضي gemini-2.0-flash - راجع الاسم الحالي)
  META_API_KEY أو TOGETHER_API_KEY (عبر together.ai)
  META_MODEL, META_BASE_URL (لتغيير نموذج Llama أو المزود)
  SWARM_AUTORUN_I_UNDERSTAND_THE_RISK=yes  يلغي سؤال y/n قبل التشغيل (خطر، انظر SWARM_SECURITY_AR.md)
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

from swarm_security import autorun_enabled, check_code


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
        return ("```python\n# generated in MOCK mode (unverified)\ndef run():\n    return 'mock tool is working'\n\n"
                "if __name__ == '__main__':\n    print(run())\n```")
    return {
        "plan": "[MOCK] 1. Understand the goal\n2. Pick libraries\n3. Write run()\n4. Test it",
        "review": "MOCK-UNVERIFIED\nNo real review happened. This is not a PASS.",
        "evolve": "",
    }.get(kind, "[MOCK] notes: prefer the standard library first.")


def _gemini(system, prompt):
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        raise RuntimeError("GEMINI_API_KEY is not set in the environment")
    model = os.environ.get("GEMINI_MODEL", "gemini-2.0-flash")
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    r = requests.post(
        url,
        headers={"x-goog-api-key": key, "Content-Type": "application/json"},
        json={"system_instruction": {"parts": [{"text": system}]},
              "contents": [{"parts": [{"text": prompt}]}]},
        timeout=120,
    )
    r.raise_for_status()
    return r.json()["candidates"][0]["content"]["parts"][0]["text"]


def _meta(system, prompt):
    env = os.environ
    key = env.get("META_API_KEY") or env.get("TOGETHER_API_KEY")
    if not key:
        raise RuntimeError("META_API_KEY or TOGETHER_API_KEY is not set in the environment")
    base, model = "https://api.together.xyz/v1", "meta-llama/Llama-3.3-70B-Instruct-Turbo"
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
        self.last_mock = False
        self.has = {
            "gemini": bool(env.get("GEMINI_API_KEY")),
            "meta": bool(env.get("META_API_KEY") or env.get("TOGETHER_API_KEY")),
        }
        self.mode = (mode or env.get("SWARM_MODE", "mock")).lower()
        if self.mode not in ("mock", "gemini", "meta", "hybrid"):
            print(f"! وضع غير معروف {self.mode} -> mock")
            self.mode = "mock"
        if self.mode in ("gemini", "meta") and not self.has[self.mode]:
            sys.exit(f"خطأ: الوضع {self.mode} يحتاج مفتاحا في متغيرات البيئة (GEMINI_API_KEY أو META_API_KEY/TOGETHER_API_KEY). لا رجوع صامت لوضع mock.")
        if self.mode == "hybrid" and not any(self.has.values()):
            sys.exit("خطأ: الوضع hybrid يحتاج مفتاحا واحدا على الأقل في متغيرات البيئة.")
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
        self.last_mock = backend == "mock"
        try:
            if backend == "gemini":
                return _gemini(system, prompt)
            if backend == "meta":
                return _meta(system, prompt)
        except Exception as e:  # شبكة، مفتاح غلط، حد استخدام...
            print(f"   ! {backend} فشل ({type(e).__name__}) -> ناتج وهمي موسوم MOCK")
        self.last_mock = True
        return _mock(kind)


# ---------- الأدوات المكتوبة ----------
# تنبيه: الفحص (swarm_security.check_code) قائمة سماح وطبقة دفاع، مش sandbox.
# الحماية الفعلية: سؤال y/n قبل التشغيل + حاوية معزولة (SWARM_SECURITY_AR.md).
def extract_code(text):
    m = re.search(r"```(?:python)?\s*\n(.*?)```", text, re.S | re.I)
    return (m.group(1) if m else text).strip()


def save_tool(ws, task, code):
    reg_path = ws / "tools" / "registry.json"
    reg = jload(reg_path, [])
    path = ws / "tools" / f"tool_{len(reg) + 1:03d}.py"
    path.write_text(code + "\n", encoding="utf-8")
    reg.append({"file": path.name, "task": task, "time": time.strftime("%Y-%m-%d %H:%M")})
    jsave(reg_path, reg)
    return path


def run_tool(path):
    if not autorun_enabled():
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
        self.last_mock = self.router.last_mock
        tag = "[MOCK] " if self.last_mock and not out.startswith("[MOCK]") else ""
        entry = {"time": time.strftime("%Y-%m-%d %H:%M"), "in": prompt[:120], "out": tag + out[:200],
                 "mock": self.last_mock}
        self.mem["history"] = (self.mem["history"] + [entry])[-20:]
        self.mem["done"] += 1
        if self.mem["done"] % self.evolve_every == 0 and not self.last_mock:
            self.evolve()
        jsave(self.path, self.mem)
        return out

    def evolve(self):
        recent = "\n".join(f"- {h['in']} => {h['out']}" for h in self.mem["history"][-3:])
        new = self.router.ask(
            "evolve", "You improve AI agent instructions.",
            f"Role: {self.role}\nCurrent lessons: {self.mem['lessons']}\nRecent work:\n{recent}\n"
            "Write the updated lessons, at most 5 short lines, nothing else.")
        if new.strip() and not self.router.last_mock:
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
        self.mock_used = False

    def post(self, who, content):
        self.board = (self.board + [{"from": who, "time": time.strftime("%H:%M:%S"), "content": content[:500]}])[-50:]
        jsave(self.board_path, self.board)

    def step(self, name, kind, prompt, default=""):
        agent = self.agents.get(name)
        if not agent:
            return default
        print(f"   • {name}...")
        out = agent.work(kind, prompt)
        if agent.last_mock:
            self.mock_used = True
        self.post(name, ("[MOCK] " if agent.last_mock and not out.startswith("[MOCK]") else "") + out)
        return out

    def run_one(self, task):
        print(f"\n=== المهمة: {task}")
        self.mock_used = False
        plan = self.step("Architect", "plan", f"Task: {task}")
        notes = self.step("Researcher", "text", f"Task: {task}\nPlan:\n{plan}")
        ctx = f"Task: {task}\nPlan:\n{plan}\nNotes:\n{notes}"
        code = extract_code(self.step("Coder", "code", ctx))
        problem = check_code(code)
        if problem:  # محاولة تصحيح واحدة
            code = extract_code(self.step("Coder", "code", ctx + f"\nYour previous code was rejected: {problem}. Fix it."))
            problem = check_code(code)

        review, out, fname = "UNREVIEWED (no tester)", "", ""
        status = f"rejected: {problem}" if problem else ""
        if not problem:
            review = self.step("Tester", "review", f"Task: {task}\nCode:\n{code}", review)
            if self.mock_used:
                status = "mock-unverified (not saved, not run)"
            elif review.strip().upper().startswith("PASS"):
                path = save_tool(self.ws, task, code)
                fname, status = path.name, "saved"
                out = run_tool(path)
            else:
                status = "failed review"
        self.step("Evolver", "text", f"Task: {task}\nStatus: {status}\nReview: {review[:200]}\nOutput: {out[:200]}")
        print(f"   النتيجة: {status} {fname} {out[:80]}")
        self.results.append({"task": task, "status": status, "tool": fname, "output": out,
                             "mock": self.mock_used})

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
            lines.append(f"- {'[MOCK] ' if r.get('mock') else ''}**{r['task']}** -> {r['status']} {r['tool']}\n  output: {r['output']}")
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
