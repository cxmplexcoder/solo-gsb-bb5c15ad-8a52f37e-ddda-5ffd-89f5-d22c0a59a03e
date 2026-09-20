"""陶瓷窑车层架载荷追踪台 —— Flask 后端。

路由：
  GET  /              前端页面
  GET  /api/sample    示例数据（容器内置 data/sample.json）
  POST /api/compute   提交整架 JSON，返回载荷计算结果
"""

from __future__ import annotations

import json
import os
import sys

# 支持 gunicorn 从项目根目录以 "app:app" 加载：把本文件所在目录加入模块路径
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from flask import Flask, jsonify, render_template, request  # noqa: E402

from engine import compute  # noqa: E402

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SAMPLE_PATH = os.environ.get("SAMPLE_PATH", os.path.join(BASE_DIR, "data", "sample.json"))

app = Flask(__name__, template_folder="templates", static_folder="static")
app.config["JSON_AS_ASCII"] = False


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/sample")
def get_sample():
    try:
        with open(SAMPLE_PATH, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return jsonify(data)
    except FileNotFoundError:
        return jsonify({"ok": False, "errors": [f"示例数据不存在：{SAMPLE_PATH}"]}), 404
    except json.JSONDecodeError as exc:
        return jsonify({"ok": False, "errors": [f"示例数据 JSON 解析失败：{exc}"]}), 500


@app.post("/api/compute")
def do_compute():
    data = request.get_json(silent=True)
    if data is None:
        return jsonify({"ok": False, "errors": ["请求体不是合法的 JSON"]}), 400
    result = compute(data)
    return jsonify(result)


@app.get("/healthz")
def healthz():
    return jsonify({"ok": True})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    app.run(host="0.0.0.0", port=port, debug=os.environ.get("FLASK_DEBUG") == "1")
