#!/bin/sh
# Process-prewarmed ACP benchmark for dsh-acp.
#
# Starts one fresh, isolated VM + initialized agent per iteration, performs the
# real ACP initialize/session/new/session/prompt flow, and sends a greeting to
# DeepSeek by default. Requires DEEPSEEK_API_KEY in the environment.
#
#   sh scripts/bench-pool-dsh-acp.sh [path-to-kbox] [greeting]
set -eu

KBOX="${1:-kbox}"
export KBOX
export GREETING="${2:-你好！请用一句话介绍你自己。}"
export RUNS="${RUNS:-5}"
IMAGE="ghcr.io/kense-labs/dsh-acp:latest"
export IMAGE
POOL_LOG="${POOL_LOG:-/dev/stderr}"

: "${DEEPSEEK_API_KEY:?Set DEEPSEEK_API_KEY before running this benchmark}"
command -v "$KBOX" >/dev/null 2>&1 || {
  echo "kbox executable not found: $KBOX" >&2
  exit 1
}
case $("$KBOX" pool start --help 2>&1) in
  *--prewarm*) ;;
  *)
    echo "kbox is too old: upgrade to a release with pool start --prewarm and pool attach" >&2
    exit 1
    ;;
esac
"$KBOX" pool attach --help >/dev/null 2>&1 || {
  echo "kbox is too old: upgrade to a release with pool start --prewarm and pool attach" >&2
  exit 1
}

idle() {
  "$KBOX" pool status --json | python3 -c \
    "import json,sys
try: print(json.load(sys.stdin)[0]['idle'])
except Exception: print(0)"
}

wait_idle() {
  n=0
  while [ "$(idle)" -lt 1 ]; do
    if ! kill -0 "$DAEMON" 2>/dev/null; then
      if wait "$DAEMON"; then status=0; else status=$?; fi
      echo "pool start exited ($status) before a VM + process became ready; see $POOL_LOG" >&2
      exit 1
    fi
    n=$((n + 1))
    [ "$n" -le 90 ] || { echo "timed out waiting for a ready VM + process" >&2; exit 1; }
    sleep 2
  done
}

if [ "${REUSE_POOL:-0}" != 1 ]; then
  "$KBOX" pool stop >/dev/null 2>&1 || true
  "$KBOX" pool start --deferred --prewarm --image "$IMAGE" \
    --size 1 --max 2 -u root -e DEEPSEEK_API_KEY >"$POOL_LOG" 2>&1 &
  DAEMON=$!
  trap '"$KBOX" pool stop >/dev/null 2>&1 || true; kill "$DAEMON" >/dev/null 2>&1 || true' EXIT INT TERM
  echo "warming VM + dsh-acp process for $IMAGE"
  wait_idle
fi

python3 - <<'PY'
import json
import os
import statistics
import subprocess
import threading
import time

KBOX = os.environ["KBOX"]
GREETING = os.environ["GREETING"]
RUNS = int(os.environ["RUNS"])


def wait_idle():
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        status = subprocess.run(
            [KBOX, "pool", "status", "--json"],
            check=True, capture_output=True, text=True,
        )
        images = json.loads(status.stdout)
        if images and images[0]["idle"] >= 1:
            return
        time.sleep(0.1)
    raise TimeoutError("no process-prewarmed VM became idle within 180s")


def run_session(run):
    wait_idle()
    started = time.perf_counter()
    proc = subprocess.Popen(
        [KBOX, "pool", "attach"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    responses = {}
    chunks = []
    stderr_lines = []
    condition = threading.Condition()

    def reader():
        for line in proc.stdout:
            received = time.perf_counter()
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            with condition:
                if "id" in message and ("result" in message or "error" in message):
                    responses[message["id"]] = (received, message)
                elif message.get("method") == "session/update":
                    update = message.get("params", {}).get("update", {})
                    if update.get("sessionUpdate") == "agent_message_chunk":
                        content = update.get("content", {})
                        if content.get("type") == "text":
                            chunks.append(content.get("text", ""))
                condition.notify_all()

    def stderr_reader():
        stderr_lines.extend(proc.stderr.readlines())

    threading.Thread(target=reader, daemon=True).start()
    threading.Thread(target=stderr_reader, daemon=True).start()

    def send(message):
        sent = time.perf_counter()
        proc.stdin.write(json.dumps(message, ensure_ascii=False) + "\n")
        proc.stdin.flush()
        return sent

    def wait(request_id, timeout):
        deadline = time.monotonic() + timeout
        with condition:
            while request_id not in responses:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError(f"no response for request {request_id}")
                if proc.poll() is not None:
                    raise RuntimeError(
                        f"pool attach exited {proc.returncode}: {''.join(stderr_lines)}"
                    )
                condition.wait(min(remaining, 0.1))
            received, message = responses[request_id]
        if "error" in message:
            raise RuntimeError(message["error"])
        return received, message["result"]

    try:
        initialize_sent = send({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion": 1, "clientCapabilities": {}},
        })
        initialize_received, info = wait(1, 30)
        send({
            "jsonrpc": "2.0", "id": 2, "method": "session/new",
            "params": {"cwd": "/workspace", "mcpServers": []},
        })
        _, session = wait(2, 30)
        config_options = session.get("configOptions", [])

        def choices(config_id):
            option = next((item for item in config_options if item.get("id") == config_id), None)
            if option is None:
                return []
            return [
                choice
                for group in option.get("options", [])
                for choice in (group.get("options", []) if "group" in group else [group])
            ]

        def set_config(request_id, config_id, value):
            send({
                "jsonrpc": "2.0", "id": request_id,
                "method": "session/set_config_option",
                "params": {
                    "sessionId": session["sessionId"],
                    "configId": config_id,
                    "value": value,
                },
            })
            _, configured = wait(request_id, 30)
            return configured["configOptions"]

        requested_model = os.environ.get("DSH_MODEL", "").strip()
        if requested_model:
            model_value = None
            available_models = []
            for choice in choices("model"):
                try:
                    provider, model = json.loads(choice["value"])
                except (ValueError, TypeError, KeyError):
                    continue
                available_models.append(f"{provider}/{model}")
                if requested_model in (model, f"{provider}/{model}"):
                    model_value = choice["value"]
                    break
            if model_value is None:
                raise RuntimeError(
                    f"unknown DSH_MODEL {requested_model!r}; available: {', '.join(available_models)}"
                )
            config_options = set_config(3, "model", model_value)

        requested_effort = os.environ.get("DSH_REASONING_EFFORT", "").strip()
        if requested_effort:
            effort_choices = choices("reasoning_effort")
            if requested_effort not in [choice.get("value") for choice in effort_choices]:
                available = ", ".join(str(choice.get("value")) for choice in effort_choices)
                raise RuntimeError(
                    f"unknown DSH_REASONING_EFFORT {requested_effort!r}; available: {available}"
                )
            config_options = set_config(4, "reasoning_effort", requested_effort)

        model_option = next(item for item in config_options if item.get("id") == "model")
        provider, model = json.loads(model_option["currentValue"])
        reasoning_option = next(
            (item for item in config_options if item.get("id") == "reasoning_effort"), None,
        )
        selected_effort = (
            reasoning_option.get("currentValue") or "provider_default"
            if reasoning_option is not None else None
        )
        prompt_sent = send({
            "jsonrpc": "2.0", "id": 5, "method": "session/prompt",
            "params": {
                "sessionId": session["sessionId"],
                "prompt": [{"type": "text", "text": GREETING}],
            },
        })
        prompt_received, result = wait(5, 240)
        reply = "".join(chunks).strip()
        if not reply:
            raise RuntimeError("the model returned no text")
    finally:
        proc.stdin.close()
        try:
            exit_code = proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
            raise

    if exit_code != 0:
        raise RuntimeError(f"pool attach returned {exit_code}: {''.join(stderr_lines)}")
    sample = {
        "run": run,
        "spawn_to_initialize_ms": (initialize_received - started) * 1000,
        "initialize_rtt_ms": (initialize_received - initialize_sent) * 1000,
        "prompt_rtt_ms": (prompt_received - prompt_sent) * 1000,
        "agent": info["agentInfo"]["name"],
        "provider": provider,
        "model": model,
        "reasoning_effort": selected_effort,
        "stop_reason": result.get("stopReason"),
        "reply": reply,
        "exit_code": exit_code,
    }
    print(json.dumps(sample, ensure_ascii=False), flush=True)
    return sample


samples = [run_session(run) for run in range(1, RUNS + 1)]
for metric in ("spawn_to_initialize_ms", "initialize_rtt_ms"):
    values = [sample[metric] for sample in samples]
    print(
        f"{metric}: min={min(values):.3f} median={statistics.median(values):.3f} "
        f"max={max(values):.3f} ms",
        flush=True,
    )
PY

if [ "${REUSE_POOL:-0}" = 1 ]; then
  echo "pool retained"
else
  echo "pool stopped"
fi
