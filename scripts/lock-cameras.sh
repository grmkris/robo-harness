#!/usr/bin/env bash
# Pin the lab cameras' image settings so auto-focus/exposure/white-balance
# cannot drift the picture between trials. Runs on lab-pi. Settings are lost
# whenever a camera re-enumerates, so camera-recover.sh re-applies them.
#
# Values measured 2026-09-23 with the lamp on (workspace C922): focus 0-20 is
# sharpest on the mat, exposure 330 (x100 us, just under the 30 fps frame time)
# matches the auto-exposure brightness (mean 110 vs 111).
set -euo pipefail

if [ -e /dev/cam_context ]; then
  v4l2-ctl -d /dev/cam_context \
    -c focus_automatic_continuous=0 -c focus_absolute=10 \
    -c auto_exposure=1 -c exposure_dynamic_framerate=0 -c exposure_time_absolute=330 \
    -c white_balance_automatic=0 -c white_balance_temperature=4000
fi
# The wrist Innomaker is already manual; pin the values it runs with today.
if [ -e /dev/cam_wrist ]; then
  v4l2-ctl -d /dev/cam_wrist \
    -c auto_exposure=1 -c exposure_time_absolute=221 \
    -c white_balance_automatic=0 -c white_balance_temperature=3108
fi
echo "cameras locked"
