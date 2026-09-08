"""Deterministic local Expect checks. No external model, real motors, or paid inference."""

from pathlib import Path
import json
import os
import re
import subprocess
import sys
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ.get("ROBO_BROWSER_URL", "http://127.0.0.1:5178")
EXPECT_ENV = {
    **os.environ,
    "ROBO_EXPECT_SESSION": "/tmp/robo-harness-expect-session.json",
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
        raise RuntimeError(label + ": " + result.stdout[-1500:] + result.stderr[-1500:])
    print("PASS", label, flush=True)


state = json.load(urllib.request.urlopen(BASE + "/api/status"))
assert state["observation"]["backend"] == "mock", "Browser test must never operate real motors"
assert state["access_mode"] == "tailnet", "Browser test expects tokenless Tailscale access"
opened = subprocess.run(
    ["expect-cli", "open", BASE], capture_output=True, text=True, timeout=60, env=EXPECT_ENV
)
if opened.returncode:
    raise RuntimeError("Opening local browser: " + opened.stderr[-1500:])
browser(
    "await page.context().clearCookies(); await page.goto("
    + json.dumps(BASE)
    + ", {waitUntil:'domcontentloaded'}); await page.getByRole('heading', {name:'The robot workbench.'}).waitFor();"
    + "if(await page.getByLabel('Operator token').count())throw new Error('Unexpected login prompt');",
    "workbench opens without a token",
)
if os.environ.get("ROBO_BROWSER_TERMINAL_ONLY") == "1":
    browser(
        r"""
await page.getByRole('button',{name:'terminal',exact:true}).click();
await page.evaluate(async()=>{
 const headers={'X-Robo-Browser':sessionStorage.getItem('robo-controller'),'Content-Type':'application/json'};
 const sessions=await(await fetch('/api/terminals',{headers})).json();
 for(const session of sessions)if(session.status!=='exited')await fetch(`/api/terminals/${session.id}/close`,{method:'POST',headers,body:'{}'});
});
await page.getByRole('button',{name:'Open terminal',exact:true}).click();
await page.waitForFunction(()=>document.querySelector('.terminal-toolbar')?.textContent?.includes('Connected'),null,{timeout:20000});
await page.getByLabel('Interactive terminal input').pressSequentially(`python -c "import os; print('TTY_OK', os.isatty(0))"`,{delay:1});
await page.getByLabel('Interactive terminal input').press('Enter');
await page.waitForFunction(()=>document.querySelector('[aria-label="Terminal output"]')?.textContent?.includes('TTY_OK True'));
await page.getByLabel('Interactive terminal input').pressSequentially('export WORKSPACE_CHECK=still_here');
await page.getByLabel('Interactive terminal input').press('Enter');
await page.getByLabel('Interactive terminal input').pressSequentially('python -q');
await page.getByLabel('Interactive terminal input').press('Enter');
await page.waitForFunction(()=>document.querySelector('[aria-label="Terminal output"]')?.textContent?.includes('>>>'));
await page.getByLabel('Interactive terminal input').pressSequentially("print('REPL_RESULT',6*7); open('.terminal-acceptance','w').write('workspace-kept')");
await page.getByLabel('Interactive terminal input').press('Enter');
await page.waitForFunction(()=>document.querySelector('[aria-label="Terminal output"]')?.textContent?.includes('REPL_RESULT 42'));
await page.getByLabel('Interactive terminal input').pressSequentially('import time; time.sleep(30)');
await page.getByLabel('Interactive terminal input').press('Enter');
await page.getByRole('button',{name:'Ctrl-C',exact:true}).click();
await page.waitForFunction(()=>document.querySelector('[aria-label="Terminal output"]')?.textContent?.includes('KeyboardInterrupt'));
await page.getByLabel('Interactive terminal input').pressSequentially('exit()');
await page.getByLabel('Interactive terminal input').press('Enter');
""",
        "interactive Docker TTY, Python REPL, and Ctrl-C",
    )
    browser(
        r"""
const before=await page.evaluate(async()=> (await(await fetch('/api/terminals',{headers:{'X-Robo-Browser':sessionStorage.getItem('robo-controller')}})).json())[0]);
await page.getByRole('button',{name:'chat',exact:true}).click();
await page.getByRole('button',{name:'terminal',exact:true}).click();
await page.waitForFunction(()=>document.querySelector('.terminal-toolbar')?.textContent?.includes('Connected'),null,{timeout:10000});
await page.getByLabel('Interactive terminal input').pressSequentially(`printf 'RESTORED:%s\n' "$WORKSPACE_CHECK"`);
await page.getByLabel('Interactive terminal input').press('Enter');
await page.waitForFunction(()=>document.querySelector('[aria-label="Terminal output"]')?.textContent?.includes('RESTORED:still_here'));
const after=await page.evaluate(async()=> (await(await fetch('/api/terminals',{headers:{'X-Robo-Browser':sessionStorage.getItem('robo-controller')}})).json())[0]);
if(after.id!==before.id)throw new Error('Reconnect created a new shell');
await page.setViewportSize({width:390,height:844});
await page.waitForFunction(async cols=>(await(await fetch('/api/terminals',{headers:{'X-Robo-Browser':sessionStorage.getItem('robo-controller')}})).json())[0].cols<cols,before.cols,{timeout:10000});
if(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+2))throw new Error('Terminal overflows mobile viewport');
await page.setViewportSize({width:1440,height:1100});
await page.getByRole('button',{name:'Close terminal',exact:true}).click();
await page.waitForFunction(()=>document.querySelector('.terminal-toolbar')?.textContent?.includes('Terminal closed'),null,{timeout:10000});
const closed=await page.evaluate(async()=> (await(await fetch('/api/terminals',{headers:{'X-Robo-Browser':sessionStorage.getItem('robo-controller')}})).json())[0]);
if(closed.status!=='exited')throw new Error('Terminal did not exit');
await page.getByText('Run a single command',{exact:true}).click();
await page.getByLabel('Shell command').fill(`python -c "print('BATCH_OK',open('.terminal-acceptance').read())"`);
await page.getByRole('button',{name:'Run command'}).click();
await page.waitForFunction(()=>document.querySelector('.terminal-output')?.textContent?.includes('BATCH_OK workspace-kept'),null,{timeout:30000});
""",
        "terminal reconnect, mobile resize, cleanup, and shared files in the single-command runner",
    )
    result = subprocess.run(
        ["expect-cli", "screenshot", "--full-page"], capture_output=True, text=True, timeout=60, env=EXPECT_ENV
    )
    if result.returncode:
        raise RuntimeError(result.stderr)
    print(result.stdout.strip())
    sys.exit(0)
if os.environ.get("ROBO_BROWSER_CHAT_ONLY") == "1":
    browser(
        r"""
await page.addInitScript(()=>{
 const Native=window.EventSource;
 window.EventSource=class extends Native {
  constructor(...args){super(...args);window.__roboTestSource=this;this.addEventListener('message',event=>{this.__lastId=Number(event.lastEventId)||this.__lastId||0;});}
 };
});
await page.reload({waitUntil:'domcontentloaded'});
await page.getByRole('heading',{name:'The robot workbench.'}).waitFor();
""",
        "observe the browser event stream for replay acceptance",
    )
    browser(
        r"""
await page.getByRole('button',{name:'chat',exact:true}).click();
await page.getByLabel('Model',{exact:true}).selectOption('alibaba:fixture');
await page.getByLabel('Model image capability').waitFor();
if(!(await page.getByLabel('Model image capability').innerText()).includes('Camera images enabled'))throw new Error('Vision capability missing');
await page.getByLabel('Model',{exact:true}).selectOption('alibaba:qwen3-coder-next');
if(!(await page.getByLabel('Model image capability').innerText()).includes('Text only'))throw new Error('Selected model capability did not change');
await page.getByLabel('Model',{exact:true}).selectOption('alibaba:fixture');
await page.getByLabel('Message the robot agent').fill('Move the mock gripper a little and report the measured result.');
await page.getByRole('button',{name:'Send ↗',exact:true}).click();
await page.waitForFunction(()=>document.querySelector('.chat-log')?.textContent?.includes('Invalid tool arguments'),null,{timeout:15000});
await page.waitForFunction(()=>document.querySelector('.motion-progress')?.textContent?.includes('measured completion'),null,{timeout:15000});
await page.waitForFunction(()=>document.querySelector('.chat-log')?.textContent?.includes('Fixture move completed'),null,{timeout:15000});
if((await page.locator('.chat-log').innerText()).includes('Tool failed'))throw new Error('Generic error hid useful validation details');
if(await page.locator('.motion-progress').count()!==1)throw new Error('Progress was not coalesced by action');
await page.waitForFunction(async()=>{const s=await(await fetch('/api/status')).json();return s.observation.operator===null&&s.observation.operation.status==='completed';},null,{timeout:10000});
""",
        "chat model capabilities, validation recovery, and measured motion",
    )
    browser(
        r"""
await page.setViewportSize({width:390,height:844});
await page.getByRole('button',{name:'STOP / HOLD'}).scrollIntoViewIfNeeded();
if(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+2))throw new Error('Mobile page overflows');
await page.setViewportSize({width:1440,height:1100});
await page.evaluate(()=>window.scrollTo(0,0));
""",
        "chat layout and stop remain usable on mobile",
    )
    browser(
        r"""
await page.evaluate(()=>{
 const source=window.__roboTestSource;
 if(!source?.__lastId)throw new Error('SSE did not expose a durable event ID');
 const event={id:source.__lastId+1,time:Date.now(),type:'chat.delta',data:{session_id:sessionStorage.getItem('robo-conversation'),text:'ReplayProbe'}};
 const send=()=>source.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(event),lastEventId:String(event.id)}));
 send();send();
});
await page.waitForFunction(()=>document.querySelector('.chat-log')?.textContent?.includes('ReplayProbe'));
if(((await page.locator('.chat-log').innerText()).match(/ReplayProbe/g)||[]).length!==1)throw new Error('Replay duplicated the streaming draft');
await page.evaluate(()=>{
 const source=window.__roboTestSource;
 source.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({id:source.__lastId+1,time:Date.now(),type:'chat.finished',data:{session_id:sessionStorage.getItem('robo-conversation')}})}));
});
""",
        "replayed deltas update the draft exactly once",
    )
    result = subprocess.run(
        ["expect-cli", "screenshot", "--full-page"], capture_output=True, text=True, timeout=60, env=EXPECT_ENV
    )
    if result.returncode:
        raise RuntimeError(result.stderr)
    print(result.stdout.strip())
    sys.exit(0)
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
await page.getByText('Run a single command',{exact:true}).click();
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
