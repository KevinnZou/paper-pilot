#!/bin/sh
# 本地预览：起一个静态文件服务器（零依赖，macOS 自带 python3）
# 用法：sh tools/serve.sh [端口]   默认端口 8000
cd "$(dirname "$0")/.."
exec python3 -m http.server "${1:-8000}"
