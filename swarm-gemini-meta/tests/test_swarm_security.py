# -*- coding: utf-8 -*-
"""اختبارات أمان وإخلاص المخرجات لسكربت السرب المُصلَح.

تغطي أربع نقاط:
1) رفض الكود الخطر (AST).
2) رفض التنفيذ دون موافقة صريحة (الافتراضي رفض، ولا متغير بيئة يلغيه).
3) الفشل الواضح عند غياب المفتاح أو فشل النموذج الحقيقي (لا رجوع صامتًا إلى Mock).
4) وسم مخرجات Mock بـ [MOCK] وعدم حفظها في الذاكرة وعدم اعتبارها نجاح اختبار.
"""
import ast
import os
import sys
from pathlib import Path
from unittest import mock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from final_gemini_meta_swarm import (  # noqa: E402
    MOCK_TAG,
    Agent,
    Router,
    Swarm,
    _gemini,
    _meta,
    check_code,
    extract_code,
    run_tool,
)


@pytest.fixture(autouse=True)
def clean_env(monkeypatch, tmp_path):
    """يزيل أي مفاتيح من بيئة الاختبار حتى لا تتأثر النتائج بمفاتيح جهاز المطور."""
    for k in ("GEMINI_API_KEY", "META_API_KEY", "TOGETHER_API_KEY", "GROQ_API_KEY"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("SWARM_WORKSPACE", str(tmp_path / "ws"))
    import final_gemini_meta_swarm as mod
    mod.WORKSPACE = (tmp_path / "ws").resolve()
    return tmp_path


# ============ 1) رفض الكود الخطر ============

def test_check_code_blocks_import_os():
    code = "import os\ndef run():\n    return os.getcwd()"
    assert check_code(code) is not None and "blocked import: os" in check_code(code)


def test_check_code_blocks_import_subprocess():
    code = "import subprocess\ndef run():\n    return 1"
    assert check_code(code) is not None and "subprocess" in check_code(code)


def test_check_code_blocks_importlib_import():
    code = "import importlib\ndef run():\n    return 1"
    assert check_code(code) is not None and "importlib" in check_code(code)


def test_check_code_blocks_importlib_import_from():
    code = "from importlib import util\ndef run():\n    return 1"
    assert check_code(code) is not None and "importlib" in check_code(code)


def test_check_code_blocks_eval_exec_compile():
    for call in ("eval('1+1')", "exec('x=1')", "compile('1', 's', 'eval')", "__import__('os')"):
        code = f"def run():\n    return {call}"
        problem = check_code(code)
        assert problem is not None, f"لم يُرفض الاستدعاء الخطر: {call}"


def test_check_code_blocks_getattr_on_builtins():
    code = "def run():\n    return getattr(__builtins__, 'eval')"
    problem = check_code(code)
    assert problem is not None and "getattr" in problem


def test_check_code_blocks_dunder_attribute_access():
    code = "class A:\n    pass\n\ndef run():\n    return A().__class__"
    problem = check_code(code)
    assert problem is not None and "dunder" in problem


def test_check_code_blocks_open_for_writing():
    code = "def run():\n    open('x.txt', 'w')\n    return 1"
    problem = check_code(code)
    assert problem is not None and "open()" in problem


def test_check_code_blocks_open_outside_workspace():
    code = "def run():\n    open('/etc/passwd')\n    return 1"
    problem = check_code(code)
    assert problem is not None and "مجلد العمل" in problem


def test_check_code_blocks_open_with_variable_path():
    code = "def run(p):\n    open(p)\n    return 1"
    problem = check_code(code)
    assert problem is not None


def test_check_code_allows_safe_code():
    code = "import json\nimport requests\n\ndef run():\n    return {'ok': True}"
    assert check_code(code) is None


def test_check_code_blocks_syntax_error():
    assert check_code("def run( bad syntax") is not None


def test_check_code_requires_run_function():
    assert check_code("def other():\n    return 1") is not None


# ============ 2) رفض التنفيذ دون موافقة ============

def test_run_tool_refused_without_confirmation(tmp_path):
    tool = tmp_path / "tool.py"
    marker = tmp_path / "marker.txt"
    tool.write_text(f"from pathlib import Path\nPath({str(marker)!r}).write_text('ran', encoding='utf-8')\nprint('done')\n", encoding="utf-8")
    # المستخدم رفض: لا تنفيذ إطلاقًا
    out = run_tool(tool, confirm=lambda name: False)
    assert "رفض" in out or "لم يتم التشغيل" in out
    assert not marker.exists(), "الأداة نُفِّذت رغم رفض المستخدم"


def test_run_tool_runs_after_explicit_confirmation(tmp_path):
    tool = tmp_path / "tool.py"
    tool.write_text("def run():\n    return 'result-123'\n\nif __name__ == '__main__':\n    print(run())\n", encoding="utf-8")
    out = run_tool(tool, confirm=lambda name: True)
    assert "result-123" in out


def test_run_tool_default_confirm_is_deny_on_eof(monkeypatch, tmp_path):
    """بدون إدخال (EOF مثل بيئة غير تفاعلية) يجب أن يكون الافتراضي رفض."""
    tool = tmp_path / "tool.py"
    marker = tmp_path / "marker.txt"
    tool.write_text(f"from pathlib import Path\nPath({str(marker)!r}).write_text('ran', encoding='utf-8')\n", encoding="utf-8")
    with mock.patch("builtins.input", side_effect=EOFError):
        out = run_tool(tool)  # confirm=None -> التأكيد التفاعلي الافتراضي
    assert "لم يتم التشغيل" in out
    assert not marker.exists()


def test_run_tool_runs_in_subprocess_with_timeout(tmp_path):
    """الأداة تعمل في عملية فرعية بمهلة زمنية ولا تسدّ العملية الرئيسية."""
    tool = tmp_path / "tool.py"
    tool.write_text("import time\ntime.sleep(120)\n", encoding="utf-8")
    out = run_tool(tool, confirm=lambda name: True, timeout=2)
    assert "المهلة" in out or "timeout" in out


# ============ 3) فشل واضح عند غياب المفتاح أو فشل النموذج ============

def test_router_fails_when_gemini_key_missing(clean_env):
    with pytest.raises(RuntimeError, match="GEMINI_API_KEY"):
        Router("gemini")


def test_router_fails_when_meta_key_missing(clean_env):
    with pytest.raises(RuntimeError, match="META_API_KEY"):
        Router("meta")


def test_router_fails_when_hybrid_has_no_keys(clean_env):
    with pytest.raises(RuntimeError, match="hybrid"):
        Router("hybrid")


def test_router_fails_on_unknown_mode(clean_env):
    with pytest.raises(RuntimeError, match="وضع غير معروف"):
        Router("bogus")


def test_router_requires_explicit_mode(clean_env):
    monkeypatch_del = os.environ.pop("SWARM_MODE", None)
    try:
        with pytest.raises(RuntimeError, match="SWARM_MODE غير محدد"):
            Router(None)
    finally:
        if monkeypatch_del is not None:
            os.environ["SWARM_MODE"] = monkeypatch_del


def test_gemma_call_fails_without_key(monkeypatch):
    with pytest.raises(RuntimeError, match="GEMINI_API_KEY"):
        _gemini("sys", "prompt")


def test_meta_call_fails_without_key(monkeypatch):
    with pytest.raises(RuntimeError, match="META_API_KEY"):
        _meta("sys", "prompt")


def test_ask_does_not_fall_back_to_mock_on_model_failure(monkeypatch, clean_env):
    """فشل النموذج الحقيقي يجب أن يرفع خطأ واضحًا لا أن يعود إلى Mock."""
    monkeypatch.setenv("GEMINI_API_KEY", "fake-key-for-test")
    router = Router("gemini")
    import final_gemini_meta_swarm as mod
    with mock.patch.object(mod, "_gemini", side_effect=Exception("network down")):
        with pytest.raises(RuntimeError, match="لم يتم الرجوع إلى Mock"):
            router.ask("code", "sys", "prompt")


def test_hybrid_falls_back_between_real_models_not_mock(monkeypatch, clean_env):
    """في hybrid إذا فشل meta يعود إلى gemini الحقيقي، وإذا فشلا معًا يفشل بوضوح لا إلى Mock."""
    monkeypatch.setenv("GEMINI_API_KEY", "g")
    monkeypatch.setenv("META_API_KEY", "m")
    router = Router("hybrid")
    import final_gemini_meta_swarm as mod
    calls = {"gemini": 0, "meta": 0}

    def fake_gemini(system, prompt):
        calls["gemini"] += 1
        return "real gemini output"

    with mock.patch.object(mod, "_gemini", side_effect=fake_gemini), \
         mock.patch.object(mod, "_meta", side_effect=Exception("meta down")):
        out = router.ask("code", "sys", "prompt")  # code يفضل meta لكنه سيفشل فينجح عبر gemini
    assert out == "real gemini output"
    assert calls["gemini"] == 1
    assert "MOCK" not in out

    # لو فشل النموذجان الحقيقيان معًا: فشل واضح، لا رجوع إلى Mock
    calls["gemini"] = 0
    with mock.patch.object(mod, "_gemini", side_effect=Exception("gemini down")), \
         mock.patch.object(mod, "_meta", side_effect=Exception("meta down")):
        with pytest.raises(RuntimeError, match="لم يتم الرجوع إلى Mock"):
            router.ask("code", "sys", "prompt")


# ============ 4) وسم مخرجات Mock ============

def test_mock_outputs_are_tagged():
    from final_gemini_meta_swarm import _mock
    for kind in ("code", "plan", "review", "evolve", "other"):
        assert MOCK_TAG in _mock(kind), f"مخرجات mock غير موسومة للنوع {kind}"


def test_mock_mode_never_saved_to_agent_memory(clean_env, tmp_path):
    monkeypatch = None
    router = Router("mock")
    agent = Agent("Coder", "Coder role", router, tmp_path / "ws")
    agent.work("code", "Task: test")
    assert agent.mem["history"] == [], "حُفظت مخرجات mock في الذاكرة"
    assert agent.mem["done"] == 0, "زاد عدّاد المهام رغم وضع mock"


def test_mock_tester_verdict_not_counted_as_pass(clean_env, tmp_path):
    swarm = Swarm(tmp_path / "ws", mode="mock")
    swarm.run_one("مهمة تجريبية")
    assert swarm.results[0]["status"].startswith(MOCK_TAG), "نتيجة mock عُدَّت كأنها نتيجة فعلية"
    assert swarm.results[0]["tool"] == "", "حُفظت أداة في وضع mock"


def test_mock_review_is_rejected_in_real_mode(monkeypatch, clean_env, tmp_path):
    """لو رجع المختبر ردًا موسومًا بـ [MOCK] في وضع حقيقي، لا يُعَد ناجحًا."""
    monkeypatch.setenv("GEMINI_API_KEY", "g")
    swarm = Swarm(tmp_path / "ws", mode="gemini")
    import final_gemini_meta_swarm as mod
    fake_code = "def run():\n    return 'ok'"
    fake_review = MOCK_TAG + " mock review"

    def fake_llm(system, prompt):
        # التوجيه حسب نص الدور الممرَّر في system، لا حسب محتوى الطلب
        if "Coder" in system:
            return f"```python\n{fake_code}\n```"
        if "Tester" in system:
            return fake_review
        return "some real text"

    with mock.patch.object(mod, "_gemini", side_effect=fake_llm):
        swarm.run_one("مهمة تجريبية")
    assert "MOCK" in swarm.results[0]["status"] or swarm.results[0]["status"] == "rejected: tester output is MOCK"
    assert swarm.results[0]["tool"] == "", "حُفظت أداة رغم أن نتيجة الاختبار mock"


def test_extract_code_fenced():
    text = "intro\n```python\nx = 1\n```\noutro"
    assert extract_code(text) == "x = 1"


def test_extract_code_plain():
    assert extract_code("x = 1") == "x = 1"
