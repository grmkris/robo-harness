# @robo/python

The LeRobot motor owner, the Rerun telemetry worker and the perception worker. It is a foreign HTTP boundary: the coordinator reaches it over HTTP and never imports it as a module. One motor thread is the single writer, under one lock; keep inference, encoding, Rerun and storage off that loop. Gate with `uv run --extra dev pytest`.
