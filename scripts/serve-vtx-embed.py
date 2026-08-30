#!/usr/bin/env python3
"""
OpenAI-Compatible Local Embedding Server for VTXAI/vtx-embed-7M.
Provides standard `/v1/embeddings` endpoint for agent-base kb plugin.
Zero extra web-framework dependencies (uses standard library http.server).
"""

import argparse
import json
import os
import sys
import time
import urllib.request
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

MODEL_ID = "VTXAI/vtx-embed-7M"
CACHE_DIR = Path(os.path.expanduser("~/.cache/vtx-embed-7M"))
REQUIRED_FILES = ["config.json", "tokenizer.json", "vortex_embed_v4_5.py", "model.safetensors"]

def ensure_model_files(cache_dir: Path):
    cache_dir.mkdir(parents=True, exist_ok=True)
    mirrors = [
        f"https://hf-mirror.com/{MODEL_ID}/resolve/main/",
        f"https://huggingface.co/{MODEL_ID}/resolve/main/",
    ]
    for fname in REQUIRED_FILES:
        target = cache_dir / fname
        if target.exists() and target.stat().st_size > 0:
            continue
        downloaded = False
        for base in mirrors:
            url = f"{base}{fname}"
            try:
                print(f"[vtx-server] 正在下载 {fname} 来自 {base}...")
                urllib.request.urlretrieve(url, str(target))
                if target.exists() and target.stat().st_size > 0:
                    print(f"[vtx-server] ✓ {fname} ({target.stat().st_size} 字节)")
                    downloaded = True
                    break
            except Exception as e:
                print(f"[vtx-server] 镜像下载失败 {base}: {e}")
        if not downloaded:
            raise RuntimeError(f"无法下载模型文件: {fname}")

def load_vtx_model(cache_dir: Path):
    ensure_model_files(cache_dir)
    sys.path.insert(0, str(cache_dir))
    try:
        from vortex_embed_v4_5 import VortexEmbedV4_5
        model = VortexEmbedV4_5.from_pretrained(str(cache_dir))
        print(f"[vtx-server] ✓ {MODEL_ID} 加载成功 (内存占用: {model.model_size_mb:.2f} MB, 向量维度: 256)")
        return model
    except Exception as e:
        raise RuntimeError(f"加载模型失败: {e}")

class EmbeddingRequestHandler(BaseHTTPRequestHandler):
    model_instance = None
    model_name = MODEL_ID

    def do_OPTIONS(self):
        self.send_response(200)
        self._send_cors_headers()
        self.end_headers()

    def do_GET(self):
        if self.path in ("/", "/health"):
            self._send_json(200, {
                "status": "healthy",
                "model": self.model_name,
                "dimension": 256,
                "engine": "vtx-embed-7M (VortexEmbed v4.5)",
            })
        elif self.path in ("/v1/models", "/models"):
            self._send_json(200, {
                "object": "list",
                "data": [
                    {
                        "id": self.model_name,
                        "object": "model",
                        "created": int(time.time()),
                        "owned_by": "VTXAI",
                    }
                ],
            })
        else:
            self._send_json(404, {"error": f"Not found: {self.path}"})

    def do_POST(self):
        if self.path not in ("/v1/embeddings", "/embeddings"):
            self._send_json(404, {"error": f"Not found endpoint: {self.path}"})
            return

        try:
            content_length = int(self.headers.get("Content-Length", 0))
            raw_body = self.rfile.read(content_length)
            try:
                decoded = raw_body.decode("utf-8")
            except UnicodeDecodeError:
                try:
                    decoded = raw_body.decode("gb18030")
                except UnicodeDecodeError:
                    decoded = raw_body.decode("utf-8", errors="replace")
            payload = json.loads(decoded)
        except Exception as e:
            self._send_json(400, {"error": {"message": f"Invalid JSON body: {e}", "type": "invalid_request_error"}})
            return

        input_data = payload.get("input")
        if input_data is None:
            self._send_json(400, {"error": {"message": "Missing 'input' field in request body", "type": "invalid_request_error"}})
            return

        if isinstance(input_data, str):
            texts = [input_data]
        elif isinstance(input_data, list):
            texts = [str(x) for x in input_data]
        else:
            self._send_json(400, {"error": {"message": "'input' must be string or array of strings", "type": "invalid_request_error"}})
            return

        if len(texts) == 0:
            self._send_json(200, {
                "object": "list",
                "data": [],
                "model": self.model_name,
                "usage": {"prompt_tokens": 0, "total_tokens": 0},
            })
            return

        try:
            vecs = self.model_instance.encode_batch(texts)
            # vecs shape: (N, 256)
            data_items = []
            for i, vec in enumerate(vecs):
                data_items.append({
                    "object": "embedding",
                    "index": i,
                    "embedding": [float(x) for x in vec],
                })
            
            # 粗略估算 token 消耗（字符数 * 0.6）
            total_tokens = sum(max(1, int(len(t) * 0.6)) for t in texts)
            self._send_json(200, {
                "object": "list",
                "data": data_items,
                "model": self.model_name,
                "usage": {
                    "prompt_tokens": total_tokens,
                    "total_tokens": total_tokens,
                },
            })
        except Exception as e:
            self._send_json(500, {"error": {"message": f"Inference error: {e}", "type": "internal_error"}})

    def _send_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")

    def _send_json(self, status_code: int, data: dict):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._send_cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        # 简化日志输出
        pass

def main():
    parser = argparse.ArgumentParser(description="VTXAI/vtx-embed-7M OpenAI-compatible Embeddings Server")
    parser.add_argument("--host", default="127.0.0.1", help="Host to bind (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8000, help="Port to bind (default: 8000)")
    parser.add_argument("--cache-dir", default=str(CACHE_DIR), help="Model cache directory")
    args = parser.parse_args()

    cache_dir = Path(args.cache_dir)
    print(f"[vtx-server] 正在准备 {MODEL_ID}...")
    model = load_vtx_model(cache_dir)

    EmbeddingRequestHandler.model_instance = model
    EmbeddingRequestHandler.model_name = MODEL_ID

    server = HTTPServer((args.host, args.port), EmbeddingRequestHandler)
    print(f"[vtx-server] 🚀 服务已启动: http://{args.host}:{args.port}/v1/embeddings")
    print(f"[vtx-server] 可在 agent-base 知识库插件中配置为 embedBaseUrl")
    print(f"[vtx-server] 按 Ctrl+C 停止服务")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[vtx-server] 正在关闭服务...")
        server.server_close()
        print("[vtx-server] 已退出。")

if __name__ == "__main__":
    main()
