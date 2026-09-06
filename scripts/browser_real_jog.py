"""Explicit real-arm wrist jog through Expect; HTTP verifies completion and always stops."""

import json
import os
import subprocess
import time
import urllib.request
from pathlib import Path

root = Path(__file__).resolve().parents[1]
base = "http://100.105.51.45:8940"
env = {**os.environ, "NODE_OPTIONS": "--import=" + str(root / "scripts/expect-local.mjs")}
report = {}


def http(path, body=None):
    req = urllib.request.Request(
        base + path,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=4) as r:
        return json.load(r)


def browser(code):
    r = subprocess.run(
        ["expect-cli", "playwright", code, "--description", "Real wrist jog acceptance"],
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    if r.returncode or "Error:" in r.stdout:
        raise RuntimeError(r.stdout[:2000] + r.stderr[:500])
    return r.stdout


try:
    report["before"] = http("/api/status")["observation"]
    if report["before"]["backend"] != "so101" or report["before"]["fault"]:
        raise RuntimeError("Expected healthy real arm")
    report["acquire"] = browser("""
await page['getByRole']('button',{name:'Take manual control'}).click({noWaitAfter:true,timeout:10000});
await page.waitForFunction(()=>!document['querySelector']('[aria-label="Increase wrist roll"]').disabled);
return {disabled:await page['getByRole']('button',{name:'Increase wrist roll',exact:true}).isDisabled()};
""")
    report["click"] = browser("""
await page['getByRole']('button',{name:'Increase wrist roll',exact:true}).click({noWaitAfter:true,timeout:10000});
return {alerts:await page['locator']('[role=alert]').allTextContents()};
""")
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        after = http("/api/status")["observation"]
        if after["operation"] and after["operation"]["id"] != report["before"]["operation"]["id"]:
            if after["operation"]["status"] in ("completed", "failed", "cancelled"):
                break
        time.sleep(0.15)
    report["after"] = after
    if after["operation"]["id"] == report["before"]["operation"]["id"]:
        raise RuntimeError("UI did not submit a new motion: " + report["click"])
    if after["operation"]["status"] != "completed":
        raise RuntimeError(json.dumps(after["operation"]))
    report["delta"] = after["measured"]["wrist_roll"] - report["before"]["measured"]["wrist_roll"]
    if not 0.5 <= report["delta"] <= 2.5:
        raise RuntimeError("Unexpected measured wrist displacement")
    report["result"] = "passed"
except BaseException as e:
    report["error"] = str(e)
    raise
finally:
    report["stop"] = http("/api/tool/stop", {})
    (root / "var/real-arm-acceptance/browser-wrist-jog.json").write_text(json.dumps(report, indent=2))
    print(
        json.dumps(
            {
                "result": report.get("result"),
                "error": report.get("error"),
                "delta_degrees": report.get("delta"),
                "operation": report.get("after", {}).get("operation", {}).get("id"),
                "controller_after_stop": report["stop"]["operator"],
            }
        ),
        flush=True,
    )
