#!/usr/bin/env bash
# Bring a stale lab camera back without touching the arm. Runs on lab-pi.
#   camera-recover.sh workspace|wrist [first_rung]
# Rungs, each only if the one before did not restore fresh frames:
#   1  usbreset the device (still enumerated but wedged)
#   2  disable/re-enable only its hub port (fell off the bus: "Cannot enable")
#   3  restart robo-io
# A Pi reboot is the caller's rung 4: this script cannot survive it.
# The arm boards sit behind their own hub on 1-1.1, so rungs 1-2 never reach
# them; rung 3 keeps torque (stop holds the commanded pose).
# Exit 0 = camera fresh again (which rung is printed), 1 = still stale.
set -uo pipefail

role=${1:?workspace|wrist}
first=${2:-1}
case $role in
  workspace) port=3 ;;
  wrist) port=4 ;;
  *) echo "unknown camera $role" >&2; exit 2 ;;
esac
dev=/sys/bus/usb/devices/1-1.$port
ctl=/sys/bus/usb/devices/1-1:1.0/1-1-port$port/disable
here=$(dirname "$(readlink -f "$0")")
set -a; . "$here/../var/io.env"; set +a
url=http://${ROBO_IO_HOST:-100.77.154.45}:${ROBO_IO_PORT:-8941}

fresh() {
  # Up to $1 seconds for the camera to deliver under 500 ms old frames.
  for _ in $(seq "$1"); do
    age=$(curl -s -m 2 -H "Authorization: Bearer $ROBO_IO_TOKEN" "$url/observe" |
      python3 -c "import json,sys; c=json.load(sys.stdin)['cameras']['$role']; print(0 if c['error'] is None and c['age_ms'] is not None and c['age_ms'] < 500 else 1)" 2>/dev/null)
    [ "$age" = 0 ] && return 0
    sleep 1
  done
  return 1
}

done_at() {
  "$here/lock-cameras.sh" >/dev/null 2>&1 || true
  echo "recovered $role at rung $1"
  exit 0
}

if fresh 3; then echo "$role already fresh"; exit 0; fi

if [ "$first" -le 1 ] && [ -e "$dev/busnum" ]; then
  echo "rung 1: usbreset $role"
  sudo usbreset "$(printf '%03d/%03d' "$(cat "$dev/busnum")" "$(cat "$dev/devnum")")" || true
  fresh 20 && done_at 1
fi
if [ "$first" -le 2 ]; then
  echo "rung 2: power-cycle hub port $port"
  echo 1 | sudo tee "$ctl" >/dev/null
  sleep 3
  echo 0 | sudo tee "$ctl" >/dev/null
  fresh 25 && done_at 2
fi
if [ "$first" -le 3 ]; then
  echo "rung 3: restart robo-io"
  sudo systemctl restart robo-io
  fresh 120 && done_at 3
fi
echo "$role still stale after rung 3"
exit 1
