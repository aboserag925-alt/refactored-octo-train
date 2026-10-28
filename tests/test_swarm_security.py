import importlib.util, os, sys, tempfile, unittest
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import swarm_security as sec
spec = importlib.util.spec_from_file_location("swarm_mod", ROOT / "swarm.finaly.py")
sw = importlib.util.module_from_spec(spec); spec.loader.exec_module(sw)

OK = "import json\ndef run():\n    return json.dumps({'a': 1})\n"

class AllowList(unittest.TestCase):
    def test_ok(self): self.assertIsNone(sec.check_code(OK))
    def test_importlib(self): self.assertIn("allowlist", sec.check_code("import importlib\ndef run(): pass"))
    def test_importlib_from(self): self.assertTrue(sec.check_code("from importlib import import_module\ndef run(): pass"))
    def test_getattr(self): self.assertIn("getattr", sec.check_code("def run():\n    return getattr(1,'real')"))
    def test_pathlib(self): self.assertTrue(sec.check_code("from pathlib import Path\ndef run(): Path('x').open('w')"))
    def test_open(self): self.assertTrue(sec.check_code("def run():\n    open('x')"))
    def test_os(self): self.assertTrue(sec.check_code("import os\ndef run(): pass"))
    def test_dunder(self): self.assertTrue(sec.check_code("def run():\n    return ().__class__.__bases__"))
    def test_subprocess_alias(self): self.assertTrue(sec.check_code("import subprocess as s\ndef run(): pass"))
    def test_no_run(self): self.assertIn("run()", sec.check_code("x=1"))
    def test_relative(self): self.assertTrue(sec.check_code("from . import x\ndef run(): pass"))

class Autorun(unittest.TestCase):
    def test_default_off(self): self.assertFalse(sec.autorun_enabled({}))
    def test_old_var_ignored(self): self.assertFalse(sec.autorun_enabled({"SWARM_AUTORUN": "1"}))
    def test_explicit(self): self.assertTrue(sec.autorun_enabled({sec.AUTORUN_VAR: "yes"}))

class Mock(unittest.TestCase):
    def setUp(self):
        for k in ("GEMINI_API_KEY", "META_API_KEY", "TOGETHER_API_KEY", "SWARM_AUTORUN"):
            os.environ.pop(k, None)
    def test_missing_key_fails(self):
        with self.assertRaises(SystemExit): sw.Router("gemini")
    def test_hybrid_no_keys_fails(self):
        with self.assertRaises(SystemExit): sw.Router("hybrid")
    def test_gemini_func_needs_env(self):
        with self.assertRaises(RuntimeError): sw._gemini("s", "p")
    def test_mock_review_not_pass(self):
        self.assertFalse(sw._mock("review").upper().startswith("PASS"))
    def test_mock_not_saved(self):
        with tempfile.TemporaryDirectory() as d:
            s = sw.Swarm(d, mode="mock"); s.run_one("t")
            r = s.results[0]
            self.assertTrue(r["mock"]); self.assertEqual(r["tool"], "")
            self.assertIn("mock-unverified", r["status"])
            self.assertFalse((Path(d) / "tools" / "registry.json").exists())
            self.assertIn("[MOCK]", (Path(d) / "blackboard.json").read_text(encoding="utf-8"))
    def test_no_secret_in_source(self):
        import re
        for f in ("swarm.finaly.py", "swarm_security.py"):
            self.assertIsNone(re.search(r"AIza[0-9A-Za-z_-]{20,}", (ROOT / f).read_text(encoding="utf-8")))

if __name__ == "__main__": unittest.main()
