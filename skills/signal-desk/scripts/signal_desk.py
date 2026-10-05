#!/usr/bin/env python3
"""Thin, standard-library client for the existing local Signal Desk HTTP API."""

import argparse
import json
import os
from pathlib import Path
import re
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

MAX_RESPONSE_BYTES = 8 * 1024 * 1024
MONITOR_FIELDS = {
    "name", "kind", "keywords", "aliases", "excludes", "sources", "rssUrls",
    "intervalMinutes", "minRelevance", "notifyUnverified", "cooldownMinutes",
    "active", "quality",
}


class ClientError(Exception):
    pass


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ClientError("服务返回重定向；已停止，请核对本机 Web 地址。")


def local_base_url(value):
    try:
        u = urlsplit(value)
        port = u.port
    except ValueError as exc:
        raise ClientError("无效的 Web 地址或端口。") from exc
    if (u.scheme not in {"http", "https"}
            or u.hostname not in {"127.0.0.1", "localhost", "::1"}
            or u.username is not None or u.password is not None
            or u.path not in {"", "/"} or u.query or u.fragment
            or (port is not None and not 1 <= port <= 65535)):
        raise ClientError("Web 地址须为本机 http(s) loopback 根地址，不允许凭证、路径或查询。")
    return value.rstrip("/")


def object_json(text):
    try:
        result = json.loads(text)
    except (ValueError, UnicodeError) as exc:
        raise ClientError("输入须为 UTF-8 JSON 对象。") from exc
    if not isinstance(result, dict):
        raise ClientError("输入须为 JSON 对象。")
    return result


def file_json(path):
    try:
        return object_json(Path(path).read_text(encoding="utf-8"))
    except (OSError, UnicodeError) as exc:
        raise ClientError("无法读取 UTF-8 JSON 文件。") from exc


def identifier(value):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9:_-]{0,199}", value):
        raise ClientError("无效的对象 ID，请使用服务返回的 ID。")
    return quote(value, safe="")


class Client:
    def __init__(self, base_url, timeout=15):
        self.base_url = local_base_url(base_url)
        if not 1 <= timeout <= 120:
            raise ClientError("超时范围为 1–120 秒。")
        self.timeout = timeout
        # Local requests must not go through an inherited external proxy.
        self.opener = build_opener(ProxyHandler({}), NoRedirect())

    def request(self, method, path, body=None):
        headers = {"Accept": "application/json"}
        data = None
        if method != "GET":
            data = json.dumps(body if body is not None else {},
                              ensure_ascii=False, allow_nan=False).encode("utf-8")
            if len(data) > 20000:
                raise ClientError("请求超过 Web API 的 20,000 字节限制。")
            headers["Content-Type"] = "application/json"
        req = Request(self.base_url + "/api/" + path, data=data,
                      headers=headers, method=method)
        try:
            with self.opener.open(req, timeout=self.timeout) as response:
                raw = response.read(MAX_RESPONSE_BYTES + 1)
            if len(raw) > MAX_RESPONSE_BYTES:
                raise ClientError("响应过大；请缩小筛选范围或在网页中查看。")
            return json.loads(raw.decode("utf-8"))
        except HTTPError as exc:
            # Do not echo arbitrary response bodies, which can contain private data.
            messages = {400: "输入校验失败", 403: "请求被拒绝", 404: "对象或接口不存在",
                        409: "对象正在处理或状态冲突", 415: "请求格式不支持",
                        429: "请求受限", 500: "服务错误", 503: "服务暂不可用"}
            exc.close()
            raise ClientError("HTTP %s：%s；请查看网页状态。" %
                              (exc.code, messages.get(exc.code, "请求失败"))) from exc
        except (URLError, TimeoutError, OSError) as exc:
            suffix = " 写操作可能已生效，请先查询状态，不要直接重复提交。" if method != "GET" else ""
            raise ClientError("无法连接本机服务或请求超时；请检查地址和 Web 进程。" + suffix) from exc
        except (ValueError, UnicodeError) as exc:
            raise ClientError("服务没有返回有效 UTF-8 JSON；请确认这是 Signal Desk Web。") from exc

    def dashboard(self):
        data = self.request("GET", "dashboard")
        if not isinstance(data, dict) or not isinstance(data.get("monitors"), list) or not isinstance(data.get("health"), dict):
            raise ClientError("Dashboard 结构不匹配，请确认服务版本。")
        return data

    def require_worker(self):
        if self.dashboard()["health"].get("worker") is not True:
            raise ClientError("后台 worker 离线，未提交更新/分析；请启动同一数据库的 worker。")


def execute(client, args):
    command = args.command
    if command in {"status", "monitors", "notifications", "jobs"}:
        data = client.dashboard()
        if command == "jobs":
            return data.get("pipeline", {}).get("recentJobs", [])
        if command != "status":
            return data[command]
        result = {key: data.get(key) for key in
                  ("health", "sourceStats", "xUsage", "searchUsage", "pendingCount")}
        pipeline = data.get("pipeline", {})
        result["pipeline"] = {key: pipeline.get(key) for key in
                              ("activity", "candidates", "jobs", "raw", "displayed", "usage", "contextRequests")}
        return result
    if command == "events":
        if not 1 <= args.page <= 100000:
            raise ClientError("页码范围为 1–100000。")
        query = urlencode({"filters": json.dumps(object_json(args.filters), ensure_ascii=False),
                           "page": args.page})
        return client.request("GET", "events?" + query)
    if command == "event":
        return client.request("GET", "events/" + identifier(args.id))
    if command in {"create-monitor", "edit-monitor"}:
        payload = file_json(args.file)
        unknown = payload.keys() - MONITOR_FIELDS
        if unknown:
            raise ClientError("频道文件含非输入字段，请只使用参考文档中的 MonitorInput 字段。")
        if command == "create-monitor":
            payload.setdefault("active", False)
            return client.request("POST", "monitors", payload)
        monitor_id = identifier(args.id)
        old = next((m for m in client.dashboard()["monitors"] if m["id"] == args.id), None)
        if old is None:
            raise ClientError("频道不存在，未保存。")
        merged = {key: value for key, value in old.items() if key in MONITOR_FIELDS}
        if "quality" in payload:
            if not isinstance(payload["quality"], dict):
                raise ClientError("quality 须为 JSON 对象。")
            payload["quality"] = {**old.get("quality", {}), **payload["quality"]}
        merged.update(payload)
        return client.request("PUT", "monitors/" + monitor_id, merged)
    if command == "set-active":
        return client.request("PATCH", "monitors/" + identifier(args.id), {"active": args.active})
    if command in {"update", "analyze", "retry-job"}:
        obj_id = identifier(args.id)
        client.require_worker()
        if command == "retry-job":
            path = "analysis/" + obj_id + "/retry"
        else:
            path = "monitors/" + obj_id + ("/scan" if command == "update" else "/analyze")
        return client.request("POST", path)
    if command == "feedback":
        return client.request("POST", "events/" + identifier(args.id) + "/feedback",
                              {"verdict": args.verdict})
    if command == "read-notification":
        return client.request("POST", "notifications/" + identifier(args.id) + "/read")
    raise ClientError("未知命令。")


def parser():
    p = argparse.ArgumentParser(description="Signal Desk 本机 HTTP API 客户端，不直接调用 X 或 AI。")
    p.add_argument("--base-url", default=os.environ.get("SIGNAL_DESK_URL", "http://127.0.0.1:3000"))
    p.add_argument("--timeout", type=float, default=15)
    commands = p.add_subparsers(dest="command", required=True)
    for name in ["status", "monitors", "notifications", "jobs"]:
        commands.add_parser(name)
    events = commands.add_parser("events")
    events.add_argument("--filters", default="{}", help="FeedFilters JSON 对象，参数详见 references/api.md")
    events.add_argument("--page", type=int, default=1)
    for name in ["event", "update", "analyze", "retry-job", "read-notification"]:
        commands.add_parser(name).add_argument("id")
    for name in ["create-monitor", "edit-monitor"]:
        command = commands.add_parser(name)
        if name == "edit-monitor":
            command.add_argument("id")
        command.add_argument("--file", required=True, help="UTF-8 JSON 文件")
    active = commands.add_parser("set-active")
    active.add_argument("id")
    choice = active.add_mutually_exclusive_group(required=True)
    choice.add_argument("--active", dest="active", action="store_true")
    choice.add_argument("--paused", dest="active", action="store_false")
    feedback = commands.add_parser("feedback")
    feedback.add_argument("id")
    feedback.add_argument("--verdict", required=True,
                          choices=["valuable", "irrelevant", "duplicate", "insufficient"])
    return p


def main():
    args = parser().parse_args()
    try:
        result = execute(Client(args.base_url, args.timeout), args)
        print(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False))
        return 0
    except (ClientError, ValueError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
