# Record, review, share and train

In the workbench, choose **Recordings**, give the session a label, and press **Start recording**. Both cameras, observations, commanded joint targets and events are captured. Press **Stop recording**, then **Review & export**.

The editor previews both cameras at a chosen time and exposes task/action bookmarks. Select an interval, describe the task, and mark the observed outcome and any human intervention. **Create MP4** supports one/both cameras, a measurement overlay, and 1×/2×/4×/8× speed. **Export LeRobot** preserves both cameras and original timing, regardless of video presentation settings. Download links appear after completion. Files stay private to the authenticated harness.

Agent tools are available through `discover_tools` with group `recording`: `recording_start`, `recording_stop`, `recording_list`, `recording_inspect`, `recording_frame`, `recording_export`. Recorded frames are historical evidence. The agent can inspect an experiment and create derivatives without access to the deployed filesystem or credentials.

Exports preserve originals and include interval provenance, task, outcome and intervention. A LeRobot ZIP contains `dataset/` and `episode.json`. Unpack it before loading with `LeRobotDataset(repo_id="local/robo-harness", root=".../dataset", video_backend="pyav")`. Ten-hertz joint commands and measurements are recorded in degrees, with gripper percentage; the `action` column contains sampled commanded targets.

Incomplete recordings can still produce a diagnostic MP4 but cannot become training episodes. Training also rejects time gaps over 250 ms and camera/state skew over 150 ms. Review successful demonstrations before training a policy. SmolVLA is the first proposed policy; collecting data does not start training or deploy control.

## Export environment

MP4 export uses the ordinary project's PyAV/Pillow dependencies. Native LeRobot export uses an isolated CPU environment:

```sh
uv venv var/export-venv
TMPDIR=$PWD/var/test-tmp uv pip install --python var/export-venv/bin/python \
  -r config/export-requirements.txt \
  --extra-index-url https://download.pytorch.org/whl/cpu \
  --index-strategy unsafe-best-match
```

The coordinator uses `ROBO_EXPORT_PYTHON` if supplied, then `var/export-venv/bin/python` when present, otherwise the ordinary `.venv/bin/python`. Export runs offline, without provider credentials or access to motors. Intervals are limited to five minutes; one job runs at a time, with a two-minute timeout.

For native export directly on disk, `robo-export RECORDING OUTPUT --repo-id local/robo-harness` remains available in an environment with LeRobot installed. Do not run a stock hardware recorder beside Robo Harness: Python remains the only motor owner.
