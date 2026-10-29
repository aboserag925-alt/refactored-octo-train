"""جسر بين بوت تيليجرام ووكيل السرب (swarm_finaly.py).

المبدأ: البوت يرسل مهمة نصية، والجسر يشغّل السرب في عملية فرعية معزولة
بمهلة زمنية وبدون إدخال (stdin مغلق)، فلا تُشغَّل أي أداة تلقائيا.
الأداة المولَّدة تُحفظ فقط، ولا تُشغَّل إلا بعد موافقة صريحة من مشرف.

لا يقرأ هذا الملف أي مفتاح. المفاتيح تُمرَّر من البيئة إلى العملية الفرعية فقط.
"""
import json
import os
import re
import secrets
import subprocess
import sys
import threading
import time
from pathlib import Path

SWARM_SCRIPT = Path(__file__).resolve().parents[2] / "swarm_finaly.py"
TOOL_RE = re.compile(r"^tool_\d{3}\.py$")
# متغيرات تُمرَّر للسرب فقط. SWARM_AUTORUN وما يشبهه لا يمرّ أبدا.
PASS_ENV = ("PATH", "LANG", "SWARM_MODE", "SWARM_WORKSPACE", "GEMINI_API_KEY", "GEMINI_MODEL",
            "META_API_KEY", "TOGETHER_API_KEY", "GROQ_API_KEY", "META_MODEL", "META_BASE_URL")
FORBIDDEN_ENV = ("SWARM_AUTORUN", "SWARM_AUTORUN_I_UNDERSTAND_THE_RISK")


class BridgeError(Exception):
    """خطأ متوقع برسالة عربية تُعرض للمشرف."""


def parse_admin_ids(raw):
    """يحوّل '123,456' إلى مجموعة أرقام صحيحة. القيمة الفارغة تعطي مجموعة فارغة."""
    ids = set()
    for part in (raw or "").split(","):
        part = part.strip()
        if part:
            ids.add(int(part))
    return ids


class AgentBridge:
    def __init__(self, admin_ids, workspace=None, log_path=None, timeout=120, tool_timeout=20,
                 max_reply=3500, max_task=1000, approval_ttl=600, require_container=True,
                 script=None):
        self.admin_ids = {int(i) for i in admin_ids}
        if not self.admin_ids:
            raise BridgeError("ADMIN_IDS فارغ. لا يعمل الجسر بدون مشرفين.")
        for name in FORBIDDEN_ENV:
            if os.environ.get(name):
                raise BridgeError(f"المتغير {name} ممنوع مع الجسر. احذفه.")
        if require_container and os.environ.get("AGENT_BRIDGE_CONTAINER") != "1":
            raise BridgeError("الجسر يعمل داخل الحاوية المعزولة فقط (SWARM_SECURITY_AR.md). "
                              "اضبط AGENT_BRIDGE_CONTAINER=1 داخلها.")
        self.ws = Path(workspace or os.environ.get("SWARM_WORKSPACE", "swarm_final_workspace")).resolve()
        self.log_path = Path(log_path or self.ws / "bridge_log.jsonl")
        self.timeout, self.tool_timeout = timeout, tool_timeout
        self.max_reply, self.max_task, self.approval_ttl = max_reply, max_task, approval_ttl
        self.script = Path(script or SWARM_SCRIPT)
        self._lock = threading.Lock()
        self._pending = {}
        self.last = None  # آخر مهمة: للحالة

    # ---------- ضوابط ----------
    def is_admin(self, user_id):
        return isinstance(user_id, int) and user_id in self.admin_ids

    def _require_admin(self, user_id):
        if not self.is_admin(user_id):
            self.log(user_id, "denied", "")
            raise BridgeError("غير مصرّح.")

    def log(self, user_id, action, detail):
        try:
            self.log_path.parent.mkdir(parents=True, exist_ok=True)
            row = {"ts": time.strftime("%Y-%m-%d %H:%M:%S"), "user": user_id,
                   "action": action, "detail": str(detail)[:300]}
            with open(self.log_path, "a", encoding="utf-8") as f:
                f.write(json.dumps(row, ensure_ascii=False) + "\n")
        except OSError:
            pass

    def _env(self, with_keys=True):
        env = {k: os.environ[k] for k in PASS_ENV if k in os.environ}
        if not with_keys:
            for k in list(env):
                if k.endswith("_API_KEY"):
                    del env[k]
        env["SWARM_WORKSPACE"] = str(self.ws)
        return env

    def _clip(self, text):
        text = (text or "").strip()
        return text if len(text) <= self.max_reply else text[: self.max_reply] + "\n...(مقطوع)"

    # ---------- إرسال مهمة ----------
    def submit(self, user_id, task):
        """يشغّل السرب على المهمة. لا يشغّل أي أداة. يرجع dict فيه reply وقائمة tools."""
        self._require_admin(user_id)
        task = (task or "").strip()
        if not task:
            raise BridgeError("اكتب المهمة بعد الأمر.")
        if len(task) > self.max_task:
            raise BridgeError(f"المهمة أطول من {self.max_task} حرفا.")
        if not self._lock.acquire(blocking=False):
            raise BridgeError("فيه مهمة شغالة. استنى لحد ما تخلص.")
        try:
            self.ws.mkdir(parents=True, exist_ok=True)
            self.log(user_id, "submit", task)
            started = time.time()
            try:
                r = subprocess.run([sys.executable, "-I", str(self.script), task],
                                   cwd=str(self.ws), env=self._env(), stdin=subprocess.DEVNULL,
                                   capture_output=True, text=True, timeout=self.timeout)
            except subprocess.TimeoutExpired:
                self.last = {"user": user_id, "status": "timeout", "ts": started}
                self.log(user_id, "timeout", task)
                raise BridgeError(f"انتهت المهلة ({self.timeout} ثانية).")
            results = self.ws / "RESULTS.md"
            text = results.read_text(encoding="utf-8") if results.exists() and results.stat().st_mtime >= started - 1 else (r.stdout or r.stderr)
            tools = self._new_tools()
            status = "ok" if r.returncode == 0 else f"exit {r.returncode}"
            self.last = {"user": user_id, "status": status, "ts": started, "tools": tools}
            self.log(user_id, "result", f"{status} tools={tools}")
            return {"status": status, "reply": self._clip(text), "tools": tools}
        finally:
            self._lock.release()

    def _new_tools(self):
        reg = self.ws / "tools" / "registry.json"
        try:
            data = json.loads(reg.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return []
        return [d["file"] for d in data[-1:] if TOOL_RE.match(str(d.get("file", "")))]

    # ---------- الموافقة على تشغيل أداة ----------
    def request_approval(self, user_id, tool):
        self._require_admin(user_id)
        if not TOOL_RE.match(tool or "") or not (self.ws / "tools" / tool).is_file():
            raise BridgeError("اسم أداة غير صالح.")
        self._pending = {k: v for k, v in self._pending.items() if v["exp"] > time.time()}
        token = secrets.token_hex(6)
        self._pending[token] = {"user": user_id, "tool": tool, "exp": time.time() + self.approval_ttl}
        self.log(user_id, "approval_requested", tool)
        return token

    def decide(self, user_id, token, approve):
        """y/n من المشرف نفسه الذي طلب. لا تشغيل إلا مع approve=True وطلب صالح."""
        self._require_admin(user_id)
        item = self._pending.pop(token, None)
        if not item or item["exp"] < time.time():
            raise BridgeError("الطلب منتهي أو غير موجود.")
        if item["user"] != user_id:
            self.log(user_id, "approval_wrong_user", item["tool"])
            raise BridgeError("هذا الطلب لمشرف آخر.")
        if not approve:
            self.log(user_id, "rejected", item["tool"])
            return "تم الرفض. لم يُشغَّل شيء."
        path = self.ws / "tools" / item["tool"]
        self.log(user_id, "run_approved", item["tool"])
        try:
            r = subprocess.run([sys.executable, "-I", path.name], cwd=str(path.parent),
                               env=self._env(with_keys=False), stdin=subprocess.DEVNULL,
                               capture_output=True, text=True, timeout=self.tool_timeout)
            out = self._clip(r.stdout or r.stderr) or "(لا مخرجات)"
        except subprocess.TimeoutExpired:
            out = "انتهت مهلة تشغيل الأداة."
        self.log(user_id, "run_result", out)
        return out

    def status(self, user_id):
        self._require_admin(user_id)
        return {"workspace": str(self.ws), "busy": self._lock.locked(),
                "mode": os.environ.get("SWARM_MODE", "mock"),
                "pending_approvals": len(self._pending), "last": self.last}
