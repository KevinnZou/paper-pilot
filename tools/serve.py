#!/usr/bin/env python3
"""本地预览服务器：静态文件 + 禁用缓存（避免开发中 JS 被浏览器缓存导致看不到最新改动）

用法：python3 tools/serve.py [端口]   默认 8000
"""
import http.server
import socketserver
import sys
import os
from functools import partial

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(('', PORT), partial(NoCacheHandler, directory=ROOT)) as httpd:
    print(f'服务已启动: http://localhost:{PORT} （Ctrl+C 停止）', flush=True)
    httpd.serve_forever()
