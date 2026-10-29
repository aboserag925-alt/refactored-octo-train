import os
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from integrations.telegram.agent_bridge import AgentBridge, BridgeError, parse_admin_ids

FAKE = textwrap.dedent('''
    import json, os, sys, time
    from pathlib import Path
    ws = Path(os.environ["SWARM_WORKSPACE"])
    (ws / "tools").mkdir(parents=True, exist_ok=True)
    if sys.argv[1] == "sleep":
        time.sleep(30)
    (ws / "tools" / "tool_001.py").write_text("print('hello')\\n")
    (ws / "tools" / "registry.json").write_text(json.dumps([{"file": "tool_001.py"}]))
    (ws / "RESULTS.md").write_text("autorun=" + str(os.environ.get("SWARM_AUTORUN")) + " key=" + str(os.environ.get("TG_SECRET")))
''')


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.script = self.dir / "fake_swarm.py"
        self.script.write_text(FAKE)
        for k in ("SWARM_AUTORUN", "SWARM_AUTORUN_I_UNDERSTAND_THE_RISK"):
            os.environ.pop(k, None)

    def tearDown(self):
        self.tmp.cleanup()

    def make(self, **kw):
        return AgentBridge({1}, workspace=self.dir / "ws", script=self.script,
                           require_container=False, **kw)

    def test_non_admin_denied_and_logged(self):
        b = self.make()
        with self.assertRaises(BridgeError):
            b.submit(2, "x")
        self.assertIn("denied", b.log_path.read_text(encoding="utf-8"))

    def test_empty_admins_refused(self):
        with self.assertRaises(BridgeError):
            AgentBridge(set(), require_container=False)

    def test_autorun_env_refused(self):
        os.environ["SWARM_AUTORUN"] = "1"
        with self.assertRaises(BridgeError):
            self.make()

    def test_container_required(self):
        os.environ.pop("AGENT_BRIDGE_CONTAINER", None)
        with self.assertRaises(BridgeError):
            AgentBridge({1}, workspace=self.dir / "w")

    def test_submit_does_not_run_tool_and_hides_secrets(self):
        os.environ["TG_SECRET"] = "leak"
        b = self.make()
        res = b.submit(1, "task")
        self.assertEqual(res["tools"], ["tool_001.py"])
        self.assertIn("autorun=None key=None", res["reply"])

    def test_reply_clipped(self):
        b = self.make(max_reply=10)
        self.assertLessEqual(len(b.submit(1, "x")["reply"]), 30)

    def test_task_length_limit(self):
        with self.assertRaises(BridgeError):
            self.make(max_task=5).submit(1, "123456")

    def test_timeout(self):
        with self.assertRaises(BridgeError):
            self.make(timeout=1).submit(1, "sleep")

    def test_approval_flow(self):
        b = self.make()
        b.submit(1, "x")
        t = b.request_approval(1, "tool_001.py")
        self.assertIn("hello", b.decide(1, t, True))
        with self.assertRaises(BridgeError):
            b.decide(1, t, True)  # no reuse

    def test_reject_runs_nothing(self):
        b = self.make()
        b.submit(1, "x")
        t = b.request_approval(1, "tool_001.py")
        self.assertNotIn("hello", b.decide(1, t, False))

    def test_other_admin_cannot_approve(self):
        b = AgentBridge({1, 2}, workspace=self.dir / "ws", script=self.script, require_container=False)
        b.submit(1, "x")
        t = b.request_approval(1, "tool_001.py")
        with self.assertRaises(BridgeError):
            b.decide(2, t, True)

    def test_bad_tool_name(self):
        b = self.make()
        b.submit(1, "x")
        with self.assertRaises(BridgeError):
            b.request_approval(1, "bad/name.py")

    def test_expired_approval(self):
        b = self.make(approval_ttl=-1)
        b.submit(1, "x")
        t = b.request_approval(1, "tool_001.py")
        with self.assertRaises(BridgeError):
            b.decide(1, t, True)

    def test_parse_admin_ids(self):
        self.assertEqual(parse_admin_ids("1, 2,,3"), {1, 2, 3})


if __name__ == "__main__":
    unittest.main()
