"""Deterministic local Expect checks. No external model, real motors, or paid inference."""

from pathlib import Path
import json
import os
import re
import subprocess
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
BASE = "http://127.0.0.1:5178"
EXPECT_ENV = {
    **os.environ,
    "NODE_OPTIONS": (
        os.environ.get("NODE_OPTIONS", "") + " --import=" + str(ROOT / "scripts/expect-local.mjs")
    ).strip(),
}


def browser(code, label):
    # Expect's cursor overlay preflights every literal selector before executing
    # the script, including elements created by later actions. Bracket notation
    # preserves Playwright behavior while avoiding that premature lookup.
    code = re.sub(
        r"\.(getByRole|getByText|getByLabel|getByPlaceholder|getByTestId|locator|querySelector|querySelectorAll)\s*\(",
        r"['\1'](",
        code,
    )
    try:
        result = subprocess.run(
            ["expect-cli", "playwright", code, "--description", label],
            capture_output=True,
            text=True,
            timeout=60,
            env=EXPECT_ENV,
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError(label + ": local browser runner timed out") from None
    if result.returncode or "Error:" in result.stdout:
        raise RuntimeError(label + ": " + result.stdout[:1000] + result.stderr[:500])
    print("PASS", label, flush=True)


state = json.load(urllib.request.urlopen(BASE + "/api/status"))
assert state["observation"]["backend"] == "mock", "Browser test must never operate real motors"
assert state["access_mode"] == "tailnet", "Browser test expects tokenless Tailscale access"
browser(
    "await page.context().clearCookies(); await page.goto("
    + json.dumps(BASE)
    + ", {waitUntil:'domcontentloaded'}); await page.getByRole('heading', {name:'The robot workbench.'}).waitFor();"
    + "if(await page.getByLabel('Operator token').count())throw new Error('Unexpected login prompt');",
    "workbench opens without a token",
)
browser(
    r"""
await page.getByRole('button',{name:'STOP / HOLD'}).click({noWaitAfter:true,timeout:10000});
await page.getByRole('button',{name:'Take manual control'}).click({noWaitAfter:true,timeout:10000});
await page.getByRole('button',{name:'Increase gripper',exact:true}).waitFor({state:'visible'});
await page.waitForFunction(()=>!document.querySelector('[aria-label="Increase gripper"]').disabled);
const before=await page.evaluate(async()=> (await (await fetch('/api/status')).json()).observation.measured.gripper);
await page.getByRole('button',{name:'Increase gripper',exact:true}).click({noWaitAfter:true,timeout:10000});
await page.waitForFunction(async before=>{const s=await(await fetch('/api/status')).json();return Math.abs(s.observation.measured.gripper-before-2)<0.1&&s.observation.operation.status==='completed';},before,{timeout:10000});
await page.getByRole('button',{name:'Increase shoulder pan',exact:true}).click({noWaitAfter:true,timeout:10000});
await page.getByRole('button',{name:'STOP / HOLD'}).click({noWaitAfter:true,timeout:10000});
await page.waitForFunction(()=>document.querySelector('[aria-label="Increase gripper"]').disabled);
""",
    "jog measured completion and stop revokes control",
)
browser(
    r"""
await page.getByRole('button',{name:'Segment',exact:true}).click({noWaitAfter:true,timeout:10000});
await page.getByRole('alert').waitFor();
if(!(await page.getByRole('alert').innerText()).includes('Configure a perception'))throw new Error('Missing perception setup did not produce an actionable error');
await page.getByRole('button',{name:'Dismiss error'}).click({noWaitAfter:true,timeout:10000});
await page.getByRole('button',{name:'recordings',exact:true}).click({noWaitAfter:true,timeout:10000});
await page.getByLabel('Session label').fill('Browser validation');
await page.getByRole('button',{name:'Start recording',exact:true}).click({noWaitAfter:true,timeout:10000});
await page.getByRole('button',{name:/Stop recording/}).waitFor();
await page.waitForFunction(async()=>{const s=await(await fetch('/api/status')).json();return s.recording?.frames>=5;},null,{timeout:10000});
await page.getByRole('button',{name:/Stop recording/}).click({noWaitAfter:true,timeout:10000});
await page.getByRole('button',{name:'Replay ↗'}).first().click({noWaitAfter:true,timeout:10000});
await page.getByText('Recorded session',{exact:true}).waitFor({timeout:10000});
return {iframe:await page.locator('iframe').getAttribute('src')};
""",
    "perception setup error and recording replay",
)
browser(
    r"""
await page.getByRole('button',{name:'Return to live'}).click({noWaitAfter:true,timeout:10000});
await page.getByText('Live workspace',{exact:true}).waitFor({timeout:10000});
""",
    "return to live visualization",
)
browser(
    r"""
await page.getByRole('button',{name:'terminal',exact:true}).click({noWaitAfter:true,timeout:10000});
await page.getByLabel('Shell command').fill(`python -c "from robo_client import Robot; r=Robot(); print(r.observe()['backend'])"`);
await page.getByRole('button',{name:'Run command'}).click({noWaitAfter:true,timeout:10000});
await page.waitForFunction(()=>document.querySelector('.terminal-output')?.textContent?.includes('"code": 0'),null,{timeout:45000});
if(!(await page.locator('.terminal-output').innerText()).includes('mock'))throw new Error('Container could not call the scoped robot API');
""",
    "development container reaches scoped robot API",
)
browser(
    r"""
await page.setViewportSize({width:390,height:844});
await page.getByRole('button',{name:'STOP / HOLD'}).scrollIntoViewIfNeeded();
const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+2);
if(overflow)throw new Error('Mobile page overflows horizontally');
await page.setViewportSize({width:1440,height:1100});
await page.getByRole('button',{name:'chat',exact:true}).click({noWaitAfter:true,timeout:10000});
await page.evaluate(()=>window.scrollTo(0,0));
""",
    "mobile layout and persistent stop",
)
result = subprocess.run(
    ["expect-cli", "screenshot", "--full-page"], capture_output=True, text=True, timeout=60, env=EXPECT_ENV
)
print(result.stdout.strip())
