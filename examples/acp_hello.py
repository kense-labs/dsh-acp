#!/usr/bin/env python3
"""Hello-world for dsh-acp: send a greeting, get a live model reply.

Starts dsh-acp in a kbox MicroVM, performs the ACP handshake, creates a
session, and sends one greeting prompt (default: a short Chinese greeting).
The model's streamed reply is printed as it arrives, and the VM is removed
automatically on exit.

Usage:
    export DEEPSEEK_API_KEY=your_key
    python3 examples/acp_hello.py [your greeting]

Requirements: kbox on PATH (or KBOX=/path/to/kbox), Python 3.9+.
No third-party packages.
"""

import json
import os
import subprocess
import sys
import threading
import time

KBOX = os.environ.get("KBOX", "kbox")
IMAGE = "ghcr.io/kense-labs/dsh-acp:latest"
GREETING = sys.argv[1] if len(sys.argv) > 1 else "你好！请用一句话介绍你自己。"


def main():
    if not os.environ.get("DEEPSEEK_API_KEY"):
        sys.exit("Set DEEPSEEK_API_KEY first (https://platform.deepseek.com).")

    print(f"Starting {IMAGE} in kbox (first VM boot takes ~20 s)...", flush=True)
    proc = subprocess.Popen(
        [KBOX, "run", "-i", "--rm", "--memory", "2g", "-u", "root",
         "-v", "dsh-acp-data:/data", "-e", "DEEPSEEK_API_KEY", IMAGE],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT, text=True, bufsize=1)

    responses, lock = {}, threading.Lock()

    def send(msg):
        proc.stdin.write(json.dumps(msg) + "\n")
        proc.stdin.flush()

    def reader():
        for line in proc.stdout:
            line = line.strip()
            if not line.startswith("{"):
                continue  # kbox / VM boot log lines
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if "id" in msg and ("result" in msg or "error" in msg):
                with lock:
                    responses[msg["id"]] = msg
            elif msg.get("method") == "session/update":
                update = msg.get("params", {}).get("update", {})
                if update.get("sessionUpdate") == "agent_message_chunk":
                    content = update.get("content", {})
                    if content.get("type") == "text":
                        print(content.get("text", ""), end="", flush=True)

    threading.Thread(target=reader, daemon=True).start()

    def call(msg, timeout):
        send(msg)
        deadline = time.time() + timeout
        while time.time() < deadline:
            with lock:
                if msg["id"] in responses:
                    resp = responses[msg["id"]]
                    if "error" in resp:
                        raise RuntimeError(resp["error"])
                    return resp["result"]
            if proc.poll() is not None:
                raise RuntimeError(f"dsh-acp exited unexpectedly ({proc.returncode})")
            time.sleep(0.1)
        raise TimeoutError(f"no response to {msg['method']} within {timeout}s")

    try:
        info = call({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                     "params": {"protocolVersion": 1, "clientCapabilities": {}}}, 120)
        agent = info["agentInfo"]
        print(f"Connected: {agent['name']} {agent['version']}", flush=True)

        session = call({"jsonrpc": "2.0", "id": 2, "method": "session/new",
                        "params": {"cwd": "/workspace", "mcpServers": []}}, 60)
        print(f"You: {GREETING}", flush=True)
        print("dsh-acp: ", end="", flush=True)
        result = call({"jsonrpc": "2.0", "id": 3, "method": "session/prompt",
                       "params": {"sessionId": session["sessionId"],
                                  "prompt": [{"type": "text", "text": GREETING}]}}, 240)
        print(f"\n(stop: {result.get('stopReason')})", flush=True)
    finally:
        try:
            proc.stdin.close()
            proc.wait(timeout=30)
        except Exception:
            proc.kill()


if __name__ == "__main__":
    main()
