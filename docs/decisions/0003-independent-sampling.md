# 0003 — Poll observations and cameras independently

## Status

Accepted, 2026-09-08.

## Context

The coordinator waited for an observation and both camera responses together. A slow image request delayed publication of an already received observation, and the shared receipt timestamp made that observation appear newer than it was. Recording writes also consumed cached frames whose reported age did not advance.

## Decision

Poll observations and each camera independently, with one request in flight per camera. Keep the coordinator as the sole client boundary for the workbench and telemetry worker. Age each response conservatively by its full HTTP round trip, then by local monotonic elapsed time. Use total age for the existing 250 ms observation freshness bound. Clear cached frames from other clock domains when the robot boot changes.

## Consequences

Camera latency cannot delay joint-status publication or the other camera. Recordings and telemetry receive aged frame snapshots. The conservative transit bound can reject data sooner on a high-latency connection; wall-clock offset estimates do not authorize motion. No wire schema or motor ownership changes are required.
