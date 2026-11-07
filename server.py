#!/usr/bin/env python3
"""Architecture 后端：静态文件 + 极简存档 API（零依赖，只用标准库）。

    python server.py [端口]      # 默认 8000

API
    GET    /api/diagrams            列出所有存档名
    GET    /api/diagrams/<name>     读取一个存档
    PUT    /api/diagrams/<name>     写入/覆盖一个存档
    DELETE /api/diagrams/<name>     删除一个存档
"""
import json
import os
import re
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

BASE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(BASE, "data")
NAME_RE = re.compile(r"^[A-Za-z0-9_\-\u4e00-\u9fa5]{1,50}$")
PREFIX = "/api/diagrams"


def path_for(name):
    """把存档名映射成文件路径；名字不合法时返回 None。"""
    if not NAME_RE.match(name):
        return None
    return os.path.join(DATA, name + ".json")


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=BASE, **kw)

    # ---- helpers ----
    def send_json(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def route(self):
        path = urlparse(self.path).path
        if not path.startswith(PREFIX):
            return None
        return unquote(path[len(PREFIX):]).strip("/")

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > 5 * 1024 * 1024:
            return None
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return None

    # ---- verbs ----
    def do_GET(self):
        name = self.route()
        if name is None:
            # 只对外提供前端静态资源，源码与存档不走静态路由
            ext = os.path.splitext(urlparse(self.path).path)[1]
            if ext not in ("", ".html", ".css", ".js", ".svg", ".ico", ".png"):
                return self.send_json(404, {"error": "not found"})
            return super().do_GET()
        if not name:
            os.makedirs(DATA, exist_ok=True)
            names = sorted(f[:-5] for f in os.listdir(DATA) if f.endswith(".json"))
            return self.send_json(200, names)
        target = path_for(name)
        if not target or not os.path.exists(target):
            return self.send_json(404, {"error": "not found"})
        with open(target, encoding="utf-8") as fh:
            return self.send_json(200, json.load(fh))

    def do_PUT(self):
        name = self.route()
        if not name:
            return self.send_json(400, {"error": "missing name"})
        target = path_for(name)
        if not target:
            return self.send_json(400, {"error": "invalid name"})
        doc = self.read_json()
        if not isinstance(doc, dict) or "nodes" not in doc:
            return self.send_json(400, {"error": "bad payload"})
        os.makedirs(DATA, exist_ok=True)
        tmp = target + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(doc, fh, ensure_ascii=False, indent=2)
        os.replace(tmp, target)
        return self.send_json(200, {"ok": True, "name": name})

    do_POST = do_PUT

    def do_DELETE(self):
        name = self.route()
        target = path_for(name or "")
        if not target or not os.path.exists(target):
            return self.send_json(404, {"error": "not found"})
        os.remove(target)
        return self.send_json(200, {"ok": True})

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("PORT", 8000))
    os.makedirs(DATA, exist_ok=True)
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"Architecture 已启动: http://localhost:{port}  (Ctrl+C 停止)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    main()
