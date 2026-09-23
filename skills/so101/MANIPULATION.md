# General manipulation

1. Observe measured joints, faults, temperatures, and camera freshness. Look at both views. Locate the intended object or surface using visual reasoning and, when available, segmentation. Treat returned boxes and table coordinates as estimates with a specific source frame.
2. Plan within the commissioned safe area. Move above the approach point with at least 5 cm of clearance. Long sideways moves near the table can sweep into objects: raise before translating.
3. Use the wrist view to align the fixed jaw with the intended grasp surface. Rotate the wrist only with visible clearance. Open enough for the object without sweeping nearby obstacles.
4. Descend in small steps. Stop at the first non-settling step or unexpected contact. Inspect both views before deciding whether the achieved height is useful; do not repeatedly command the same obstruction.
5. Close slowly and inspect the reported measured opening and stalled_at. A stall is evidence of resistance, not proof of a secure grasp. Lift a small amount, look again, and verify that the object rides with the jaws and has left its original support.
6. For transport, raise to a clear height, translate over the destination, then lower cautiously. Release only with visual support. Look again to verify placement, then return to the configured home pose.

After a miss, look again before retrying: contact can move or rotate the object. Reuse current evidence rather than the previous target coordinates. Avoid repeatedly closing empty or descending into the same stalled joint position.

When image directions are uncertain, make one small safe probe above the surface and compare before/after views. Record the measured move and visible displacement. Use that local relationship only near the same pose and height; perspective changes with distance. If the effect is unclear, reobserve rather than making a larger blind move.

Each tool result describes the achieved state. Check reached, residuals, contact, stalled_at, and transient/error fields. Accepted is not completed, completed joint motion is not task success, and unknown must never be automatically retried.
