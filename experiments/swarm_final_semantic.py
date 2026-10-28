"""swarm_final_semantic.py

نسخة موحدة تشمل:
- Provider Router: mock / gemini / meta / hybrid
- ToolManager: تسجيل، اكتشاف، إعادة استخدام، تشغيل وإحصاءات
- Semantic TaskRouter: embeddings + confidence + ambiguity margin
- RoutingCalibrator: معايرة العتبات دون تشغيل الأدوات
- Swarm workflow: Architect -> Researcher -> Coder -> Tester -> Evolver

التثبيت:
    pip install requests sentence-transformers

أهم متغيرات البيئة:
    SWARM_MODE=mock|gemini|meta|hybrid
    GEMINI_API_KEY=...
    GEMINI_MODEL=...            # مطلوب عند استخدام gemini، بلا قيمة افتراضية
    META_API_KEY=...            # أو TOGETHER_API_KEY أو GROQ_API_KEY
    SWARM_WORKSPACE=swarm_final_workspace
    SWARM_EMBEDDING_MODEL=sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2
    SWARM_TOOL_THRESHOLD=0.67
    SWARM_AGENT_THRESHOLD=0.52
    SWARM_CLARIFY_THRESHOLD=0.35
    SWARM_AMBIGUITY_MARGIN=0.06

التشغيل:
    python swarm_final_semantic.py "ابنِ أداة تلخيص نصوص"
    python swarm_final_semantic.py --explain "لخص هذا المستند"
    python swarm_final_semantic.py --calibrate tests/routing_calibration.json
"""

from __future__ import annotations

import ast
import json
import os
import re
import subprocess
import sys
import time
from copy import deepcopy
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Callable, Optional

import requests


# =========================================================
# JSON helpers
# =========================================================

def jload(path: Path | str, default: Any) -> Any:
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return deepcopy(default)
    except (OSError, ValueError) as exc:
        print(f"! JSON read error {path}: {type(exc).__name__}: {exc}")
        return deepcopy(default)


def jsave(path: Path | str, data: Any) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


# =========================================================
# Agent roles
# =========================================================

ROLES = {
    "Architect": (
        "You are the Architect. Break the task into a short numbered plan "
        "of at most 6 steps and name the Python function the tool needs."
    ),
    "Researcher": (
        "You are the Researcher. List suitable Python libraries and public APIs. "
        "Prefer the standard library. Never invent URLs."
    ),
    "Coder": (
        "You are the Coder. Reply with ONE complete Python 3 script inside a "
        "```python block. Use the standard library and requests only. Define a "
        "synchronous run() and print(run()) under __main__. Never delete files; "
        "never use subprocess, os.system, eval or exec."
    ),
    "Tester": (
        "You are the Tester. Review code for bugs and safety issues. The first "
        "line must be PASS or FAIL, followed by at most 5 short reasons."
    ),
    "Evolver": (
        "You are the Evolver. Briefly state what worked, what failed, and one "
        "specific improvement for next time."
    ),
}


# =========================================================
# Provider backends and provider router
# =========================================================

def _mock(kind: str) -> str:
    if kind == "code":
        return (
            "```python\n"
            "def run():\n"
            "    return 'mock tool is working'\n\n"
            "if __name__ == '__main__':\n"
            "    print(run())\n"
            "```"
        )
    return {
        "plan": "1. Understand the goal\n2. Pick libraries\n3. Write run()\n4. Test it",
        "review": "PASS\nMock review only.",
        "evolve": "Verify output.\nKeep answers short.\nReuse tools when possible.",
    }.get(kind, "Mock notes: prefer the standard library.")


def _gemini(system: str, prompt: str) -> str:
    model = os.environ.get("GEMINI_MODEL")
    if not model:
        raise RuntimeError(
            "المتغير GEMINI_MODEL غير مضبوط. اضبطه على اسم نموذج Gemini المتاح لحسابك."
        )
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    response = requests.post(
        url,
        headers={
            "x-goog-api-key": os.environ["GEMINI_API_KEY"],
            "Content-Type": "application/json",
        },
        json={
            "system_instruction": {"parts": [{"text": system}]},
            "contents": [{"parts": [{"text": prompt}]}],
        },
        timeout=120,
    )
    response.raise_for_status()
    return response.json()["candidates"][0]["content"]["parts"][0]["text"]


def _meta(system: str, prompt: str) -> str:
    env = os.environ
    if env.get("META_API_KEY") or env.get("TOGETHER_API_KEY"):
        key = env.get("META_API_KEY") or env["TOGETHER_API_KEY"]
        base = "https://api.together.xyz/v1"
        model = "meta-llama/Llama-3.3-70B-Instruct-Turbo"
    else:
        key = env["GROQ_API_KEY"]
        base = "https://api.groq.com/openai/v1"
        model = "llama-3.3-70b-versatile"

    base = env.get("META_BASE_URL", base).rstrip("/")
    model = env.get("META_MODEL", model)
    response = requests.post(
        f"{base}/chat/completions",
        headers={"Authorization": f"Bearer {key}"},
        json={
            "model": model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": prompt},
            ],
        },
        timeout=120,
    )
    response.raise_for_status()
    return response.json()["choices"][0]["message"]["content"]


class ProviderRouter:
    def __init__(self, mode: Optional[str] = None):
        env = os.environ
        self.has = {
            "gemini": bool(env.get("GEMINI_API_KEY")),
            "meta": bool(
                env.get("META_API_KEY")
                or env.get("TOGETHER_API_KEY")
                or env.get("GROQ_API_KEY")
            ),
        }
        self.mode = (mode or env.get("SWARM_MODE", "mock")).lower()
        if self.mode not in {"mock", "gemini", "meta", "hybrid"}:
            print(f"! وضع غير معروف {self.mode}; سيتم استخدام mock")
            self.mode = "mock"
        if self.mode in {"gemini", "meta"} and not self.has[self.mode]:
            print(f"! مفتاح {self.mode} غير موجود؛ سيتم استخدام mock")
            self.mode = "mock"
        if self.mode == "hybrid" and not any(self.has.values()):
            print("! لا توجد مفاتيح مزودين؛ سيتم استخدام mock")
            self.mode = "mock"
        print(f"Provider mode: {self.mode}")

    def chain(self, kind: str) -> list[str]:
        if self.mode == "mock":
            return ["mock"]
        if self.mode in {"gemini", "meta"}:
            other = "meta" if self.mode == "gemini" else "gemini"
            return [self.mode] + ([other] if self.has.get(other) else [])
        preferred = "meta" if kind == "code" else "gemini"
        other = "gemini" if preferred == "meta" else "meta"
        return [name for name in (preferred, other) if self.has.get(name)]

    def ask(self, kind: str, system: str, prompt: str) -> str:
        errors = []
        for backend in self.chain(kind):
            try:
                if backend == "mock":
                    return _mock(kind)
                if backend == "gemini":
                    return _gemini(system, prompt)
                if backend == "meta":
                    return _meta(system, prompt)
            except Exception as exc:
                errors.append(f"{backend}: {type(exc).__name__}: {exc}")
                print(f"   ! {backend} failed: {type(exc).__name__}")
        if self.mode == "mock":
            return _mock(kind)
        raise RuntimeError("All providers failed: " + " | ".join(errors))


# =========================================================
# Generated-code safety checks
# =========================================================

BANNED_MODULES = {"subprocess", "ctypes", "pty"}
BANNED_CALLS = {
    "eval", "exec", "compile", "__import__", "os.system", "os.popen",
    "os.remove", "os.rmdir", "os.unlink", "shutil.rmtree",
}
BANNED_FROM = {
    "os": {"system", "popen", "remove", "rmdir", "unlink"},
    "shutil": {"rmtree"},
}
BANNED_METHODS = {"write_text", "write_bytes", "unlink", "rmdir", "rmtree"}


def extract_code(text: str) -> str:
    match = re.search(r"```(?:python)?\s*\n(.*?)```", text, re.S | re.I)
    return (match.group(1) if match else text).strip()


def _call_name(node: ast.AST) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        left = _call_name(node.value)
        return f"{left}.{node.attr}" if left else node.attr
    return ""


def check_code(code: str) -> Optional[str]:
    try:
        tree = ast.parse(code)
    except SyntaxError as exc:
        return f"syntax error: {exc}"

    errors: list[str] = []
    bad_names: set[str] = set()
    if not any(isinstance(node, ast.FunctionDef) and node.name == "run" for node in tree.body):
        errors.append("missing synchronous run() function")

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                root = alias.name.split(".")[0]
                if root in BANNED_MODULES:
                    errors.append(f"blocked import: {alias.name}")
                    bad_names.add(alias.asname or root)
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            for alias in node.names:
                if module.split(".")[0] in BANNED_MODULES or alias.name in BANNED_FROM.get(module, set()):
                    errors.append(f"blocked import: from {module} import {alias.name}")
                    bad_names.add(alias.asname or alias.name)

    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        name = _call_name(node.func)
        if name in BANNED_CALLS or (name and name.split(".")[0] in bad_names):
            errors.append(f"blocked call: {name}")
        if isinstance(node.func, ast.Attribute) and node.func.attr in BANNED_METHODS:
            errors.append(f"blocked method: {node.func.attr}")
        if name == "open":
            mode_node = node.args[1] if len(node.args) > 1 else next(
                (item.value for item in node.keywords if item.arg == "mode"), None
            )
            if (
                isinstance(mode_node, ast.Constant)
                and isinstance(mode_node.value, str)
                and set("wax+") & set(mode_node.value)
            ):
                errors.append("blocked: open() for writing")

    return "; ".join(dict.fromkeys(errors)) or None


# =========================================================
# Tool manager
# =========================================================

class ToolManager:
    def __init__(
        self,
        workspace: Path | str,
        check_code_fn: Optional[Callable[[str], Optional[str]]] = None,
    ):
        self.workspace = Path(workspace)
        self.tools_dir = self.workspace / "tools"
        self.tools_dir.mkdir(parents=True, exist_ok=True)
        self.registry_path = self.tools_dir / "registry.json"
        self.check_code = check_code_fn
        self.registry = self._load_registry()

    def _load_registry(self) -> list[dict]:
        data = jload(self.registry_path, [])
        return data if isinstance(data, list) else []

    def _save_registry(self) -> None:
        jsave(self.registry_path, self.registry)

    @staticmethod
    def _slug(text: str) -> str:
        text = str(text).lower().strip()
        text = re.sub(r"[^a-z0-9\u0600-\u06ff]+", "_", text).strip("_")
        return text[:40] or "tool"

    def _next_filename(self, name: str) -> str:
        base = self._slug(name)
        candidate = f"{base}.py"
        index = 2
        while (self.tools_dir / candidate).exists():
            candidate = f"{base}_{index}.py"
            index += 1
        return candidate

    def register(
        self,
        name: str,
        description: str,
        code: str,
        tags: Optional[list[str]] = None,
        task: Optional[str] = None,
    ) -> dict:
        if self.check_code:
            problem = self.check_code(code)
            if problem:
                raise ValueError(f"Tool rejected: {problem}")

        filename = self._next_filename(name)
        (self.tools_dir / filename).write_text(code.rstrip() + "\n", encoding="utf-8")
        entry = {
            "name": name,
            "file": filename,
            "description": description,
            "task": task or description,
            "tags": list(dict.fromkeys(tags or [])),
            "created": time.strftime("%Y-%m-%d %H:%M"),
            "runs": 0,
            "successes": 0,
            "failures": 0,
            "last_used": None,
            "enabled": True,
        }
        self.registry.append(entry)
        self._save_registry()
        return entry

    def list_tools(self) -> list[dict]:
        return [tool.copy() for tool in self.registry if tool.get("enabled", True)]

    def _resolve(self, tool: dict | str) -> Optional[dict]:
        if isinstance(tool, dict):
            filename = tool.get("file")
            return next((item for item in self.registry if item.get("file") == filename), tool)
        return next(
            (
                item for item in self.registry
                if item.get("name") == tool or item.get("file") == tool
            ),
            None,
        )

    def execute(self, tool: dict | str, timeout: int = 20) -> dict:
        resolved = self._resolve(tool)
        if not resolved:
            return {"ok": False, "error": "tool not found"}
        if not resolved.get("enabled", True):
            return {"ok": False, "error": "tool disabled"}

        path = self.tools_dir / resolved["file"]
        if not path.exists():
            return {"ok": False, "error": "tool file missing"}

        try:
            answer = input(f"تشغيل {resolved['name']} ({resolved['file']})؟ (y/n): ")
        except EOFError:
            answer = "n"
        if answer.strip().lower() != "y":
            return {"ok": False, "error": "execution cancelled"}

        try:
            result = subprocess.run(
                [sys.executable, path.name],
                cwd=path.parent,
                capture_output=True,
                text=True,
                timeout=timeout,
            )
            output = (result.stdout or result.stderr or "").strip()[:2000]
            ok = result.returncode == 0
            self._record_run(resolved, ok)
            return {
                "ok": ok,
                "tool": resolved["name"],
                "file": resolved["file"],
                "returncode": result.returncode,
                "output": output,
            }
        except subprocess.TimeoutExpired:
            self._record_run(resolved, False)
            return {"ok": False, "tool": resolved["name"], "error": "timeout"}
        except Exception as exc:
            self._record_run(resolved, False)
            return {
                "ok": False,
                "tool": resolved["name"],
                "error": f"{type(exc).__name__}: {exc}",
            }

    def _record_run(self, tool: dict, success: bool) -> None:
        tool["runs"] = int(tool.get("runs", 0)) + 1
        key = "successes" if success else "failures"
        tool[key] = int(tool.get(key, 0)) + 1
        tool["last_used"] = time.strftime("%Y-%m-%d %H:%M")
        self._save_registry()

    def set_enabled(self, name_or_file: str, enabled: bool) -> bool:
        tool = self._resolve(name_or_file)
        if not tool:
            return False
        tool["enabled"] = bool(enabled)
        self._save_registry()
        return True


# =========================================================
# Semantic embeddings
# =========================================================

class SemanticMatcher:
    DEFAULT_MODEL = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"

    def __init__(self, model_name: Optional[str] = None):
        self.model_name = model_name or os.environ.get(
            "SWARM_EMBEDDING_MODEL", self.DEFAULT_MODEL
        )
        self.model = None
        self.load_error: Optional[str] = None
        self.embedding_cache: dict[str, list[float]] = {}

    def _load_model(self) -> bool:
        if self.model is not None:
            return True
        if self.load_error is not None:
            return False
        try:
            from sentence_transformers import SentenceTransformer
            self.model = SentenceTransformer(self.model_name)
            return True
        except Exception as exc:
            self.load_error = f"{type(exc).__name__}: {exc}"
            print(f"! Semantic model unavailable: {self.load_error}")
            return False

    @staticmethod
    def _clean(text: str) -> str:
        return " ".join(str(text or "").strip().split())

    @staticmethod
    def _to_list(vector: Any) -> list[float]:
        if hasattr(vector, "tolist"):
            vector = vector.tolist()
        return [float(value) for value in vector]

    def encode_many(self, texts: list[str]) -> list[Optional[list[float]]]:
        cleaned = [self._clean(text) for text in texts]
        if not self._load_model():
            return [None] * len(cleaned)

        missing = list(dict.fromkeys(
            text for text in cleaned if text and text not in self.embedding_cache
        ))
        if missing:
            vectors = self.model.encode(
                missing,
                normalize_embeddings=True,
                show_progress_bar=False,
                batch_size=16,
            )
            for text, vector in zip(missing, vectors):
                self.embedding_cache[text] = self._to_list(vector)

        return [self.embedding_cache.get(text) if text else None for text in cleaned]

    def rank(self, query: str, documents: list[str]) -> list[dict]:
        if not documents:
            return []
        vectors = self.encode_many([query, *documents])
        query_vector = vectors[0]
        if query_vector is None:
            return []
        results = []
        for index, vector in enumerate(vectors[1:]):
            if vector is None:
                continue
            score = sum(a * b for a, b in zip(query_vector, vector))
            results.append({
                "index": index,
                "score": round(max(0.0, min(1.0, float(score))), 6),
            })
        return sorted(results, key=lambda item: item["score"], reverse=True)


# =========================================================
# Semantic task router
# =========================================================

@dataclass
class RouteDecision:
    route: str
    confidence: float
    reason: str
    intent: str
    tool: Optional[dict] = None
    agent: Optional[str] = None

    def to_dict(self) -> dict:
        return asdict(self)


class TaskRouter:
    INTENT_DESCRIPTIONS = {
        "code": "كتابة كود أو برنامج أو سكربت أو دالة وتنفيذ مهمة برمجية جديدة",
        "debug": "اكتشاف الأخطاء وإصلاح الأعطال والاستثناءات ومشاكل تشغيل الكود",
        "research": "البحث عن معلومات ومصادر ومقارنة خيارات أو تقنيات",
        "plan": "إنشاء خطة أو تصميم معماري أو تقسيم مشروع إلى خطوات",
        "test": "اختبار الكود ومراجعته والتحقق من الجودة والنتائج والأمان",
        "summarize": "تلخيص نص أو مستند واستخراج أهم النقاط",
        "report": "إنشاء تقرير أو تنظيم النتائج في صيغة تقرير",
        "data": "معالجة بيانات أو CSV أو JSON أو SQLite أو قواعد بيانات",
        "general": "مهمة عامة غير متخصصة تحتاج إلى تحليل أولي",
    }
    INTENT_AGENTS = {
        "code": "Coder",
        "debug": "Tester",
        "research": "Researcher",
        "plan": "Architect",
        "test": "Tester",
        "summarize": "Coder",
        "report": "Coder",
        "data": "Coder",
        "general": "Architect",
    }
    COMPLEXITY_TERMS = {
        "ابني", "بناء", "طور", "تطوير", "نظام", "مشروع", "متكامل", "كامل",
        "build", "create", "develop", "system", "project", "integrate", "architecture",
    }

    def __init__(
        self,
        tool_manager: ToolManager,
        semantic_matcher: Optional[SemanticMatcher] = None,
        tool_threshold: float = 0.67,
        agent_threshold: float = 0.52,
        clarify_threshold: float = 0.35,
        ambiguity_margin: float = 0.06,
    ):
        self.tool_manager = tool_manager
        self.semantic = semantic_matcher or SemanticMatcher()
        self.tool_threshold = float(tool_threshold)
        self.agent_threshold = float(agent_threshold)
        self.clarify_threshold = float(clarify_threshold)
        self.ambiguity_margin = float(ambiguity_margin)

    @staticmethod
    def clamp(value: float) -> float:
        return round(max(0.0, min(1.0, float(value))), 4)

    @staticmethod
    def _tool_text(tool: dict) -> str:
        tags = ", ".join(tool.get("tags", []))
        return "\n".join([
            f"Tool name: {tool.get('name', '')}",
            f"Description: {tool.get('description', '')}",
            f"Purpose: {tool.get('task', '')}",
            f"Tags: {tags}",
        ])

    def detect_intent(self, task: str) -> dict:
        intents = list(self.INTENT_DESCRIPTIONS)
        descriptions = [self.INTENT_DESCRIPTIONS[name] for name in intents]
        ranked = self.semantic.rank(task, descriptions)
        if not ranked:
            return {
                "intent": "general",
                "confidence": 0.0,
                "semantic_score": 0.0,
                "ambiguous": False,
                "method": "unavailable",
                "error": self.semantic.load_error,
            }
        best = ranked[0]
        second = ranked[1] if len(ranked) > 1 else None
        second_score = second["score"] if second else 0.0
        gap = best["score"] - second_score
        ambiguous = second is not None and gap < self.ambiguity_margin
        confidence = best["score"] * (0.85 if ambiguous else 1.0)
        return {
            "intent": intents[best["index"]],
            "confidence": self.clamp(confidence),
            "raw_confidence": self.clamp(best["score"]),
            "semantic_score": self.clamp(best["score"]),
            "second_intent": intents[second["index"]] if second else None,
            "score_gap": self.clamp(gap),
            "ambiguous": ambiguous,
            "method": "semantic_embedding",
            "model": self.semantic.model_name,
        }

    def find_best_tool(self, task: str) -> dict:
        tools = self.tool_manager.list_tools()
        if not tools:
            return {
                "tool": None,
                "confidence": 0.0,
                "raw_confidence": 0.0,
                "semantic_score": 0.0,
                "ambiguous": False,
                "score_gap": 0.0,
                "candidates": [],
                "method": "none",
            }

        ranked = self.semantic.rank(task, [self._tool_text(tool) for tool in tools])
        if not ranked:
            return {
                "tool": None,
                "confidence": 0.0,
                "raw_confidence": 0.0,
                "semantic_score": 0.0,
                "ambiguous": False,
                "score_gap": 0.0,
                "candidates": [],
                "method": "unavailable",
                "error": self.semantic.load_error,
            }

        candidates = []
        for result in ranked:
            tool = tools[result["index"]]
            semantic_score = result["score"]
            runs = max(0, int(tool.get("runs", 0)))
            successes = max(0, int(tool.get("successes", 0)))
            reliability = successes / runs if runs else 0.50
            confidence = semantic_score * 0.90 + reliability * 0.10
            confidence = min(confidence, semantic_score + 0.05)
            candidates.append({
                "tool": tool,
                "semantic_score": self.clamp(semantic_score),
                "reliability": self.clamp(reliability),
                "confidence": self.clamp(confidence),
            })

        candidates.sort(key=lambda item: item["confidence"], reverse=True)
        best = candidates[0]
        second_score = candidates[1]["confidence"] if len(candidates) > 1 else 0.0
        gap = best["confidence"] - second_score
        ambiguous = len(candidates) > 1 and gap < self.ambiguity_margin
        final_confidence = best["confidence"] * (0.85 if ambiguous else 1.0)
        return {
            "tool": best["tool"],
            "confidence": self.clamp(final_confidence),
            "raw_confidence": self.clamp(best["confidence"]),
            "semantic_score": best["semantic_score"],
            "reliability": best["reliability"],
            "ambiguous": ambiguous,
            "score_gap": self.clamp(gap),
            "method": "semantic_embedding",
            "model": self.semantic.model_name,
            "candidates": [
                {
                    "name": item["tool"].get("name"),
                    "file": item["tool"].get("file"),
                    "semantic_score": item["semantic_score"],
                    "confidence": item["confidence"],
                }
                for item in candidates[:3]
            ],
        }

    def complexity_score(self, task: str) -> float:
        normalized = re.sub(r"[^a-z0-9\u0600-\u06ff]+", " ", task.lower())
        tokens = set(normalized.split())
        score = 0.0
        if len(tokens) >= 6:
            score += 0.20
        if len(tokens) >= 12:
            score += 0.20
        score += min(0.45, len(tokens & self.COMPLEXITY_TERMS) * 0.15)
        if any(separator in f" {normalized} " for separator in (" ثم ", " وبعد ", " مع ", " and ", " then ")):
            score += 0.20
        return self.clamp(score)

    def route(self, task: str) -> RouteDecision:
        task = str(task or "").strip()
        if not task:
            return RouteDecision("clarify", 0.0, "المهمة فارغة.", "unknown")

        intent_data = self.detect_intent(task)
        tool_data = self.find_best_tool(task)
        complexity = self.complexity_score(task)

        semantic_methods = {intent_data.get("method"), tool_data.get("method")}
        if "unavailable" in semantic_methods:
            return RouteDecision(
                "clarify",
                0.0,
                "النموذج الدلالي غير متاح: " + str(self.semantic.load_error),
                intent_data.get("intent", "general"),
            )

        if (
            tool_data.get("tool") is not None
            and tool_data["raw_confidence"] >= self.tool_threshold
            and not tool_data["ambiguous"]
        ):
            tool = tool_data["tool"]
            return RouteDecision(
                "existing_tool",
                tool_data["raw_confidence"],
                f"semantic={tool_data['semantic_score']:.3f}; gap={tool_data['score_gap']:.3f}",
                intent_data["intent"],
                tool=tool,
            )

        if tool_data.get("tool") is not None and tool_data["ambiguous"]:
            return RouteDecision(
                "clarify",
                tool_data["confidence"],
                "أكثر من أداة لها معنى متقارب: " + str(tool_data["candidates"]),
                intent_data["intent"],
                tool=tool_data["tool"],
            )

        if complexity >= 0.55:
            return RouteDecision(
                "swarm",
                max(complexity, intent_data["confidence"]),
                "المهمة متعددة الخطوات ولم توجد أداة موثوقة.",
                intent_data["intent"],
            )

        if intent_data["raw_confidence"] >= self.agent_threshold and not intent_data["ambiguous"]:
            agent = self.INTENT_AGENTS.get(intent_data["intent"], "Architect")
            return RouteDecision(
                "agent",
                intent_data["raw_confidence"],
                f"semantic intent={intent_data['intent']}; score={intent_data['semantic_score']:.3f}",
                intent_data["intent"],
                agent=agent,
            )

        return RouteDecision(
            "swarm",
            max(0.40, intent_data["confidence"]),
            "الثقة أقل من حد التشغيل؛ سيتم استخدام السرب.",
            intent_data["intent"],
        )

    def explain(self, task: str) -> dict:
        return {"task": task, **self.route(task).to_dict()}


# =========================================================
# Threshold calibration
# =========================================================

class RoutingCalibrator:
    def __init__(self, task_router: TaskRouter, dataset_path: Path | str):
        self.router = task_router
        self.dataset_path = Path(dataset_path)
        self.dataset = self._load_dataset()
        self.score_cache: list[dict] = []

    def _load_dataset(self) -> list[dict]:
        data = jload(self.dataset_path, None)
        if not isinstance(data, list) or not data:
            raise ValueError("Calibration dataset must be a non-empty JSON list")
        for index, case in enumerate(data):
            if not isinstance(case, dict) or not case.get("task"):
                raise ValueError(f"Invalid calibration case at index {index}")
            case.setdefault("expected_tool", None)
            case.setdefault("expected_intent", None)
        return data

    @staticmethod
    def _normal(value: Optional[str]) -> Optional[str]:
        return " ".join(value.lower().strip().split()) if value is not None else None

    def _matches(self, predicted: Optional[dict], expected: Optional[str]) -> bool:
        if expected is None:
            return predicted is None
        if predicted is None:
            return False
        possibilities = {
            self._normal(predicted.get("name")),
            self._normal(predicted.get("file")),
        }
        return self._normal(expected) in possibilities

    def prepare(self) -> list[dict]:
        self.score_cache = []
        print("Preparing semantic calibration scores...")
        for index, case in enumerate(self.dataset, 1):
            self.score_cache.append({
                "case": deepcopy(case),
                "tool_result": self.router.find_best_tool(case["task"]),
                "intent_result": self.router.detect_intent(case["task"]),
            })
            print(f"  [{index}/{len(self.dataset)}] {case['task'][:60]}")
        return self.score_cache

    @staticmethod
    def _predict_tool(result: dict, threshold: float, margin: float) -> tuple[Optional[dict], str]:
        tool = result.get("tool")
        if tool is None:
            return None, "no_candidate"
        candidates = result.get("candidates", [])
        best = float(result.get("raw_confidence", result.get("confidence", 0.0)))
        second = float(candidates[1].get("confidence", 0.0)) if len(candidates) > 1 else 0.0
        if best - second < margin:
            return None, "ambiguous"
        if best < threshold:
            return None, "below_threshold"
        return tool, "selected"

    @staticmethod
    def _predict_intent(result: dict, threshold: float, margin: float) -> str:
        raw = float(result.get("raw_confidence", result.get("confidence", 0.0)))
        gap = float(result.get("score_gap", 1.0))
        if raw < threshold or gap < margin:
            return "general"
        return result.get("intent", "general")

    def evaluate(self, tool_threshold: float, ambiguity_margin: float, agent_threshold: float) -> dict:
        if not self.score_cache:
            self.prepare()
        tp = fp = fn = tn = intent_correct = intent_total = 0
        details = []

        for item in self.score_cache:
            case = item["case"]
            expected_tool = case.get("expected_tool")
            predicted_tool, reason = self._predict_tool(
                item["tool_result"], tool_threshold, ambiguity_margin
            )
            predicted_intent = self._predict_intent(
                item["intent_result"], agent_threshold, ambiguity_margin
            )
            correct = self._matches(predicted_tool, expected_tool)
            expects = expected_tool is not None
            selected = predicted_tool is not None

            if expects and correct:
                tp += 1
            elif expects and not selected:
                fn += 1
            elif expects and selected and not correct:
                fp += 1
                fn += 1
            elif not expects and selected:
                fp += 1
            else:
                tn += 1

            expected_intent = case.get("expected_intent")
            if expected_intent is not None:
                intent_total += 1
                intent_correct += int(predicted_intent == expected_intent)

            details.append({
                "task": case["task"],
                "expected_tool": expected_tool,
                "predicted_tool": predicted_tool.get("name") if predicted_tool else None,
                "tool_correct": correct,
                "tool_reason": reason,
                "expected_intent": expected_intent,
                "predicted_intent": predicted_intent,
                "semantic_score": item["tool_result"].get("semantic_score", 0.0),
                "confidence": item["tool_result"].get("raw_confidence", 0.0),
            })

        precision = tp / (tp + fp) if tp + fp else 1.0
        recall = tp / (tp + fn) if tp + fn else 1.0
        f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
        intent_accuracy = intent_correct / intent_total if intent_total else 1.0
        total = len(self.score_cache)
        routing_accuracy = (tp + tn) / total if total else 1.0
        safety_score = 1.0 - fp / total if total else 1.0
        objective = (
            safety_score * 0.40
            + precision * 0.25
            + recall * 0.15
            + intent_accuracy * 0.10
            + routing_accuracy * 0.10
        )
        return {
            "tool_threshold": round(tool_threshold, 3),
            "ambiguity_margin": round(ambiguity_margin, 3),
            "agent_threshold": round(agent_threshold, 3),
            "objective": round(objective, 4),
            "precision": round(precision, 4),
            "recall": round(recall, 4),
            "f1": round(f1, 4),
            "intent_accuracy": round(intent_accuracy, 4),
            "routing_accuracy": round(routing_accuracy, 4),
            "safety_score": round(safety_score, 4),
            "tp": tp,
            "fp": fp,
            "fn": fn,
            "tn": tn,
            "details": details,
        }

    def calibrate(self, minimum_precision: float = 0.90) -> dict:
        if not self.score_cache:
            self.prepare()
        results = []
        for tool_threshold in (0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80, 0.85):
            for margin in (0.02, 0.04, 0.06, 0.08, 0.10, 0.12):
                for agent_threshold in (0.40, 0.45, 0.50, 0.55, 0.60, 0.65):
                    results.append(self.evaluate(tool_threshold, margin, agent_threshold))
        safe = [item for item in results if item["precision"] >= minimum_precision]
        pool = safe or results
        pool.sort(
            key=lambda item: (
                item["objective"], item["precision"], item["safety_score"],
                item["recall"], item["intent_accuracy"],
            ),
            reverse=True,
        )
        return {
            "best": pool[0],
            "tested_configurations": len(results),
            "minimum_precision": minimum_precision,
            "precision_requirement_met": bool(safe),
            "top_results": [
                {key: value for key, value in item.items() if key != "details"}
                for item in pool[:10]
            ],
        }

    @staticmethod
    def env_values(result: dict) -> str:
        best = result["best"]
        return "\n".join([
            f"SWARM_TOOL_THRESHOLD={best['tool_threshold']}",
            f"SWARM_AGENT_THRESHOLD={best['agent_threshold']}",
            f"SWARM_AMBIGUITY_MARGIN={best['ambiguity_margin']}",
        ])


# =========================================================
# Agents and swarm
# =========================================================

class Agent:
    def __init__(self, name: str, role: str, router: ProviderRouter, workspace: Path, evolve_every: int = 3):
        self.name = name
        self.role = role
        self.router = router
        self.evolve_every = evolve_every
        self.path = workspace / "memory" / f"{name}.json"
        self.mem = jload(self.path, {"version": 1.0, "lessons": "", "history": [], "done": 0})

    @property
    def system(self) -> str:
        extra = f"\nLessons learned:\n{self.mem['lessons']}" if self.mem["lessons"] else ""
        return self.role + extra

    def work(self, kind: str, prompt: str) -> str:
        output = self.router.ask(kind, self.system, prompt)
        entry = {
            "time": time.strftime("%Y-%m-%d %H:%M"),
            "in": prompt[:120],
            "out": output[:200],
        }
        self.mem["history"] = (self.mem["history"] + [entry])[-20:]
        self.mem["done"] = int(self.mem.get("done", 0)) + 1
        if self.mem["done"] % self.evolve_every == 0:
            self.evolve()
        jsave(self.path, self.mem)
        return output

    def evolve(self) -> None:
        recent = "\n".join(
            f"- {item['in']} => {item['out']}" for item in self.mem["history"][-3:]
        )
        updated = self.router.ask(
            "evolve",
            "You improve AI agent instructions.",
            f"Role: {self.role}\nCurrent lessons: {self.mem['lessons']}\n"
            f"Recent work:\n{recent}\nWrite at most 5 short updated lessons.",
        )
        if updated.strip():
            self.mem["lessons"] = updated.strip()[:800]
            self.mem["version"] = round(float(self.mem.get("version", 1.0)) + 0.1, 1)


class Swarm:
    def __init__(
        self,
        workspace: Path | str,
        agents: tuple[str, ...] = ("Architect", "Researcher", "Coder", "Tester", "Evolver"),
        mode: Optional[str] = None,
    ):
        self.ws = Path(workspace)
        (self.ws / "tools").mkdir(parents=True, exist_ok=True)
        (self.ws / "memory").mkdir(parents=True, exist_ok=True)
        self.provider_router = ProviderRouter(mode)
        self.agents = {
            name: Agent(name, ROLES[name], self.provider_router, self.ws)
            for name in agents
        }
        self.tools = ToolManager(self.ws, check_code)
        self.semantic = SemanticMatcher(os.environ.get("SWARM_EMBEDDING_MODEL"))
        self.task_router = TaskRouter(
            self.tools,
            self.semantic,
            tool_threshold=float(os.environ.get("SWARM_TOOL_THRESHOLD", "0.67")),
            agent_threshold=float(os.environ.get("SWARM_AGENT_THRESHOLD", "0.52")),
            clarify_threshold=float(os.environ.get("SWARM_CLARIFY_THRESHOLD", "0.35")),
            ambiguity_margin=float(os.environ.get("SWARM_AMBIGUITY_MARGIN", "0.06")),
        )
        self.board_path = self.ws / "blackboard.json"
        self.version_path = self.ws / "version.json"
        self.board = jload(self.board_path, [])
        self.state = jload(self.version_path, {"swarm_version": 1.0, "tasks_done": 0})
        self.results: list[dict] = []

    def post(self, who: str, content: str) -> None:
        self.board = (
            self.board
            + [{"from": who, "time": time.strftime("%H:%M:%S"), "content": content[:500]}]
        )[-50:]
        jsave(self.board_path, self.board)

    def step(self, name: str, kind: str, prompt: str, default: str = "") -> str:
        agent = self.agents.get(name)
        if not agent:
            return default
        print(f"   • {name}...")
        output = agent.work(kind, prompt)
        self.post(name, output)
        return output

    def run_agent_route(self, task: str, decision: RouteDecision) -> dict:
        agent_name = decision.agent or "Architect"
        kind = {
            "Architect": "plan",
            "Researcher": "text",
            "Coder": "code",
            "Tester": "review",
            "Evolver": "text",
        }.get(agent_name, "text")
        output = self.step(agent_name, kind, f"Task: {task}")

        if agent_name != "Coder":
            result = {"ok": True, "agent": agent_name, "output": output}
            self.results.append({
                "task": task,
                "status": f"handled by {agent_name}",
                "tool": "",
                "output": output,
                "route": "agent",
                "confidence": decision.confidence,
            })
            return result

        code = extract_code(output)
        problem = check_code(code)
        if problem:
            return {"ok": False, "error": problem}
        if "Tester" not in self.agents:
            return {"ok": False, "error": "no Tester agent: generated code is not run without review"}
        review = self.step("Tester", "review", f"Task: {task}\nCode:\n{code}")
        if not review.strip().upper().startswith("PASS"):
            result = {"ok": False, "error": "failed review", "review": review}
            self.results.append({
                "task": task,
                "status": "failed review",
                "tool": "",
                "output": review,
                "route": "agent",
                "confidence": decision.confidence,
            })
            return result
        tool = self.tools.register(
            task, task, code, ["generated", decision.intent], task
        )
        result = self.tools.execute(tool)
        self.results.append({
            "task": task,
            "status": "executed" if result.get("ok") else "execution failed",
            "tool": tool["file"],
            "output": result.get("output") or result.get("error", ""),
            "route": "agent",
            "confidence": decision.confidence,
        })
        return result

    def run_swarm_workflow(self, task: str) -> dict:
        plan = self.step("Architect", "plan", f"Task: {task}")
        notes = self.step("Researcher", "text", f"Task: {task}\nPlan:\n{plan}")
        context = f"Task: {task}\nPlan:\n{plan}\nNotes:\n{notes}"
        code = extract_code(self.step("Coder", "code", context))
        problem = check_code(code)
        if problem:
            code = extract_code(self.step(
                "Coder", "code", context + f"\nRejected: {problem}. Fix it."
            ))
            problem = check_code(code)

        if problem:
            result = {"ok": False, "error": problem}
            self.results.append({"task": task, "status": f"rejected: {problem}", "tool": "", "output": ""})
            return result

        if "Tester" not in self.agents:
            result = {"ok": False, "error": "no Tester agent: generated code is not run without review"}
            self.results.append({"task": task, "status": "rejected: no Tester", "tool": "", "output": ""})
            return result

        review = self.step("Tester", "review", f"Task: {task}\nCode:\n{code}")
        if not review.strip().upper().startswith("PASS"):
            result = {"ok": False, "error": "failed review", "review": review}
            self.results.append({"task": task, "status": "failed review", "tool": "", "output": review})
            return result

        tool = self.tools.register(task, task, code, ["generated", "swarm"], task)
        result = self.tools.execute(tool)
        output = result.get("output") or result.get("error", "")
        self.step(
            "Evolver",
            "text",
            f"Task: {task}\nStatus: {result.get('ok')}\nReview: {review[:200]}\nOutput: {output[:200]}",
        )
        self.results.append({
            "task": task,
            "status": "executed" if result.get("ok") else "execution failed",
            "tool": tool["file"],
            "output": output,
            "route": "swarm",
        })
        return result

    def execute_route(self, task: str) -> dict:
        decision = self.task_router.route(task)
        print(
            f"   route={decision.route} intent={decision.intent} "
            f"confidence={decision.confidence:.3f}"
        )
        print(f"   reason: {decision.reason}")

        if decision.route == "existing_tool":
            result = self.tools.execute(decision.tool or {})
            if result.get("ok"):
                self.results.append({
                    "task": task,
                    "status": "reused",
                    "tool": (decision.tool or {}).get("file", ""),
                    "output": result.get("output", ""),
                    "route": "existing_tool",
                    "confidence": decision.confidence,
                })
                return result
            if result.get("error") == "execution cancelled":
                return result
            print("   ! Existing tool failed; falling back to swarm")
            return self.run_swarm_workflow(task)

        if decision.route == "agent":
            return self.run_agent_route(task, decision)

        if decision.route == "clarify":
            result = {"ok": False, "needs_clarification": True, "message": decision.reason}
            self.results.append({
                "task": task,
                "status": "needs clarification",
                "tool": "",
                "output": decision.reason,
                "route": "clarify",
                "confidence": decision.confidence,
            })
            return result

        return self.run_swarm_workflow(task)

    def run_one(self, task: str) -> dict:
        print(f"\n=== المهمة: {task}")
        result = self.execute_route(task)
        self.state["tasks_done"] = int(self.state.get("tasks_done", 0)) + 1
        if self.state["tasks_done"] % 3 == 0:
            self.state["swarm_version"] = round(float(self.state.get("swarm_version", 1.0)) + 0.1, 1)
        jsave(self.version_path, self.state)
        return result

    def run(self, tasks: list[str]) -> None:
        for task in tasks:
            self.run_one(task)
        lines = ["# نتائج التشغيل", ""]
        for item in self.results:
            lines.append(
                f"- **{item['task']}** -> {item['status']} {item.get('tool', '')}\n"
                f"  output: {item.get('output', '')}"
            )
        (self.ws / "RESULTS.md").write_text("\n".join(lines), encoding="utf-8")
        print(f"\nتم. النتائج في: {self.ws / 'RESULTS.md'}")


# =========================================================
# CLI
# =========================================================

DEFAULT_TASKS = [
    "بناء أداة تجيب سعر الدولار",
    "بناء أداة تلخيص نصوص",
    "بناء نظام تقارير يومية",
]


def run_calibration(swarm: Swarm, dataset_path: str) -> None:
    calibrator = RoutingCalibrator(swarm.task_router, dataset_path)
    result = calibrator.calibrate(
        minimum_precision=float(os.environ.get("SWARM_MIN_TOOL_PRECISION", "0.90"))
    )
    report_path = Path(os.environ.get(
        "SWARM_CALIBRATION_REPORT",
        str(swarm.ws / "routing_calibration_report.json"),
    ))
    jsave(report_path, result)
    summary = {key: value for key, value in result["best"].items() if key != "details"}
    print("\n=== أفضل معايرة ===")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print("\n=== قيم .env المقترحة ===")
    print(calibrator.env_values(result))
    print(f"\nالتقرير: {report_path}")


def main() -> None:
    args = sys.argv[1:]
    workspace = os.environ.get("SWARM_WORKSPACE", "swarm_final_workspace")
    swarm = Swarm(workspace)

    if args[:1] == ["--calibrate"]:
        dataset = args[1] if len(args) > 1 else os.environ.get(
            "SWARM_CALIBRATION_DATASET", "tests/routing_calibration.json"
        )
        run_calibration(swarm, dataset)
        return

    if args[:1] == ["--explain"]:
        task = " ".join(args[1:]).strip()
        print(json.dumps(swarm.task_router.explain(task), ensure_ascii=False, indent=2))
        return

    tasks = args or DEFAULT_TASKS
    swarm.run(tasks)


if __name__ == "__main__":
    main()
