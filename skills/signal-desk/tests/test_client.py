"""Local mock HTTP tests; never call a provider or the user's database."""

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
from pathlib import Path
import threading
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "signal_desk.py"
spec = importlib.util.spec_from_file_location("signal_desk", SCRIPT)
skill = importlib.util.module_from_spec(spec)
spec.loader.exec_module(skill)


class Handler(BaseHTTPRequestHandler):
    requests = []
    routes = {}

    def log_message(self, *args):
        pass

    def respond(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        self.requests.append((self.command, self.path, dict(self.headers), body))
        code, payload, headers = self.routes.get(self.path, (200, {"ok": True}, {}))
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        for name, value in headers.items():
            self.send_header(name, value)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    do_GET = respond
    do_POST = respond
    do_PUT = respond
    do_PATCH = respond


class ClientTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = "http://127.0.0.1:%s" % cls.server.server_port

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        Handler.requests = []
        Handler.routes = {}
        self.client = skill.Client(self.url)

    def dashboard(self, worker=True, monitors=None):
        Handler.routes["/api/dashboard"] = (200, {
            "health": {"worker": worker}, "monitors": monitors or [],
            "settings": {"model": "private-choice"}, "rawArticles": ["private-material"],
            "pipeline": {"activity": {"deep": 1}}, "xUsage": {"day": 2},
        }, {})

    def test_only_local_root_addresses(self):
        for value in ["https://example.com", "http://127.0.0.1.evil", "http://user:password@localhost",
                      "http://localhost/api", "http://localhost?key=test", "http://localhost:0",
                      "http://localhost:99999", "file:///tmp/data", "http://localhost/#fragment"]:
            with self.subTest(value=value), self.assertRaises(skill.ClientError):
                skill.local_base_url(value)
        self.assertEqual(skill.local_base_url("http://[::1]:3000/"), "http://[::1]:3000")

    def test_reads_utf8_json(self):
        Handler.routes["/api/events"] = (200, {"title": "热点情报"}, {})
        self.assertEqual(self.client.request("GET", "events")["title"], "热点情报")

    def test_post_uses_json_and_no_credentials(self):
        self.client.request("POST", "monitors/test/scan")
        method, path, headers, body = Handler.requests[0]
        self.assertEqual((method, path, body), ("POST", "/api/monitors/test/scan", b"{}"))
        self.assertEqual(headers["Content-Type"], "application/json")
        self.assertNotIn("Authorization", headers)
        self.assertNotIn("X-API-Key", headers)

    def test_redirect_does_not_follow(self):
        Handler.routes["/api/events"] = (302, {}, {"Location": self.url + "/redirect-target"})
        with self.assertRaises(skill.ClientError):
            self.client.request("GET", "events")
        self.assertEqual(len(Handler.requests), 1)

    def test_server_error_does_not_echo_body_or_retry(self):
        Handler.routes["/api/events"] = (500, {"error": "private-body-marker"}, {})
        with self.assertRaises(skill.ClientError) as caught:
            self.client.request("GET", "events")
        self.assertNotIn("private-body-marker", str(caught.exception))
        self.assertEqual(len(Handler.requests), 1)

    def test_offline_update_has_no_post(self):
        self.dashboard(worker=False)
        with self.assertRaises(skill.ClientError):
            skill.execute(self.client, argparse.Namespace(command="update", id="monitor1"))
        self.assertEqual([r[0] for r in Handler.requests], ["GET"])

    def test_online_update_queues_once(self):
        self.dashboard()
        result = skill.execute(self.client, argparse.Namespace(command="update", id="monitor1"))
        self.assertEqual(result, {"ok": True})
        self.assertEqual([(r[0], r[1]) for r in Handler.requests],
                         [("GET", "/api/dashboard"), ("POST", "/api/monitors/monitor1/scan")])

    def test_analyze_does_not_request_scan(self):
        self.dashboard()
        skill.execute(self.client, argparse.Namespace(command="analyze", id="monitor1"))
        self.assertEqual(Handler.requests[-1][:2], ("POST", "/api/monitors/monitor1/analyze"))

    def test_event_filters_are_encoded_without_losing_chinese(self):
        skill.execute(self.client, argparse.Namespace(command="events", filters='{"query":"编程","hours":"all"}', page=2))
        method, url, _, _ = Handler.requests[0]
        parsed = urlsplit(url)
        query = parse_qs(parsed.query)
        self.assertEqual((method, parsed.path), ("GET", "/api/events"))
        self.assertEqual(json.loads(query["filters"][0]), {"query": "编程", "hours": "all"})
        self.assertEqual(query["page"], ["2"])

    def test_status_does_not_expose_full_settings_or_materials(self):
        self.dashboard()
        result = skill.execute(self.client, argparse.Namespace(command="status"))
        self.assertNotIn("settings", result)
        self.assertNotIn("rawArticles", result)
        self.assertEqual(result["pipeline"]["activity"]["deep"], 1)

    def test_partial_edit_preserves_other_fields(self):
        self.dashboard(monitors=[{"id": "monitor1", "name": "原频道", "kind": "topic",
                                 "keywords": "Agent", "sources": ["x"], "active": False,
                                 "quality": {"blockedAccounts": ["blocked"], "observationMinutes": 120}}])
        with patch.object(skill, "file_json", return_value={"quality": {"engagementMode": "strict"}}):
            skill.execute(self.client, argparse.Namespace(command="edit-monitor", id="monitor1", file="ignored"))
        payload = json.loads(Handler.requests[-1][3])
        self.assertEqual(payload["name"], "原频道")
        self.assertFalse(payload["active"])
        self.assertNotIn("id", payload)
        self.assertEqual(payload["quality"], {"blockedAccounts": ["blocked"],
                                            "observationMinutes": 120, "engagementMode": "strict"})

    def test_create_defaults_to_paused(self):
        with patch.object(skill, "file_json", return_value={"name": "频道", "kind": "topic", "keywords": "Agent", "sources": ["x"]}):
            skill.execute(self.client, argparse.Namespace(command="create-monitor", file="ignored"))
        self.assertFalse(json.loads(Handler.requests[-1][3])["active"])

    def test_identifier_cannot_change_route(self):
        for value in ["../settings", "/settings", "a?x=1", "..", "a#fragment"]:
            with self.subTest(value=value), self.assertRaises(skill.ClientError):
                skill.identifier(value)
        self.assertEqual(skill.identifier("deep:123"), "deep%3A123")

    def test_oversized_body_is_not_sent(self):
        with self.assertRaises(skill.ClientError):
            self.client.request("POST", "monitors", {"name": "长" * 7000})
        self.assertEqual(Handler.requests, [])


if __name__ == "__main__":
    unittest.main()
