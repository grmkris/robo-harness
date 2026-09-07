"""Read-only real-hardware UI acceptance through local Expect; never submits motion."""

import json
import os
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENV = {**os.environ, "NODE_OPTIONS": "--import=" + str(ROOT / "scripts/expect-local.mjs")}
BASE = os.environ.get("ROBO_URL", "http://127.0.0.1:8940")


def browser(code, label):
    code = re.sub(r"\.(getByRole|getByText|getByLabel|locator|querySelector)\s*\(", r"['\1'](", code)
    try:
        r = subprocess.run(
            ["expect-cli", "playwright", code, "--description", label],
            env=ENV,
            capture_output=True,
            text=True,
            timeout=60,
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError(label + ": browser timed out") from None
    if r.returncode or "Error:" in r.stdout:
        raise RuntimeError(label + ": " + r.stdout[:1500] + r.stderr[:500])
    print("PASS", label, r.stdout.strip(), flush=True)


browser(
    "await page.goto("
    + json.dumps(BASE)
    + ", {waitUntil:'domcontentloaded'});"
    + r"""
await page.getByRole('heading',{name:'The robot workbench.'}).waitFor();
await page.waitForFunction(()=>document.querySelector('.backend')?.textContent==='SO-101');
if(await page.getByLabel('Operator token').count())throw new Error('Unexpected token prompt');
const s=await page.evaluate(async()=>(await(await fetch('/api/status')).json()));
if(s.observation.backend!=='so101'||s.observation.fault||!s.telemetry.online)throw new Error('Real telemetry unhealthy');
if(s.observation.operator)throw new Error('Arm should be holding without a controller');
if(!(await page.getByRole('button',{name:'Increase gripper',exact:true}).isDisabled()))throw new Error('Jog available without a lease');
return {backend:s.observation.backend,cameras:s.observation.cameras,telemetry:s.telemetry.online};
""",
    "real workbench opens without login and shows healthy telemetry",
)
browser(
    r"""
await page.getByRole('button',{name:'recordings',exact:true}).click({noWaitAfter:true,timeout:10000});
await page.getByRole('button',{name:'Replay ↗'}).first().click({noWaitAfter:true,timeout:10000});
await page.getByText('Recorded session',{exact:true}).waitFor({timeout:10000});
const src=await page.locator('iframe').getAttribute('src');
if(!decodeURIComponent(src).includes('/replay.rrd'))throw new Error('Replay URL is not a saved recording');
return {replay:src};
""",
    "real recording opens in embedded Rerun",
)
browser(
    r"""
await page.getByRole('button',{name:'Return to live'}).click({noWaitAfter:true,timeout:10000});
await page.getByText('Live workspace',{exact:true}).waitFor({timeout:10000});
await page.getByRole('button',{name:'terminal',exact:true}).click({noWaitAfter:true,timeout:10000});
await page.getByLabel('Shell command').fill(`python -c "from robo_client import Robot; r=Robot(); o=r.observe(); print(o['backend'], o['fault'], o['measured'])"`);
await page.getByRole('button',{name:'Run command'}).click({noWaitAfter:true,timeout:10000});
await page.waitForFunction(()=>document.querySelector('.terminal-output')?.textContent?.includes('"code": 0'),null,{timeout:45000});
const output=await page.locator('.terminal-output').innerText();
if(!output.includes('so101 None'))throw new Error('Container did not reach healthy real robot');
return {output};
""",
    "workbench Python terminal observes the real arm",
)
browser(
    r"""
await page.setViewportSize({width:1440,height:1100});
await page.getByRole('button',{name:'chat',exact:true}).click({noWaitAfter:true,timeout:10000});
await page.evaluate(()=>window.scrollTo(0,0));
return {frames:page.frames().map(f=>f.url())};
""",
    "live workbench restored",
)
for args in (["screenshot", "--full-page"], ["console_logs"]):
    r = subprocess.run(["expect-cli", *args], env=ENV, capture_output=True, text=True, timeout=60)
    print(r.stdout.strip(), flush=True)
