# White-piece approach blocked by weak joint response

Date: 2026-09-09

The operator requested a pickup. During the initial read-only camera inspection, the operator also started a Qwen workbench conversation, `ab662d18-7c2b-4d4e-9c3d-705eb122a608`, first asking to observe the workspace and then to move the gripper toward the white piece. The assistant's separate pickup runner refused to start because that conversation was active. No competing controller or additional motion was started; the assistant monitored the workbench run and independently captured both cameras afterward.

WorkBench run `e06199f1-4d86-452b-a3d1-af52dad8dee4` made three bounded approach/diagnostic probes:

| Joint | Initial | Target | Duration | Measured change | Result |
| --- | --: | --: | --: | --: | --- |
| Shoulder pan | 1.890° | 2.890° | 1.5 s | 0.000° | Failed to settle |
| Shoulder pan | 1.890° | 2.890° | 4 s | 0.000° | Failed to settle |
| Shoulder lift | 12.879° | 13.880° | 4 s | +0.088° | Failed to settle |

The run ended after nine model steps, eight tool calls, and zero completed actions. All three outcomes were known failures. Final shoulder-lift feedback was 12.967° with a 0.913° residual; final shoulder-pan feedback remained 1.890°. Wrist roll changed by one encoder tick from −2.418° to −2.505° during the first probe. The gripper was not opened or brought around the object, and no lift or grasp was attempted.

Independent before/after camera inspection showed the white piece remaining on the mat and the gripper separate from it, with no meaningful approach. After-camera frames were workspace sequence 113854 and wrist sequence 113880, both from motor boot `65fe5549-f59b-412c-a931-a9659f463aa8`, about 42 and 53 ms old. The final state had no running conversation, no control owner, and no reported fault. The commanded pose was held with torque behavior unchanged.

This does not establish whether the cause is power, small-command response under load, servo configuration, command delivery, or mechanical resistance. A timeout is not proof of a seized motor; a successful prior wrist probe is not proof that every joint can move. No raw torque, goal, current, voltage, or servo-error registers were inspected during this attempt. Qwen's stronger diagnostic exclusions and its quantitative visual claims are not independently established by this run.

No configuration, gains, calibration, motion bounds, or motor code was changed. Further pickup work requires diagnosing the poor joint response. Evidence is preserved in `var/pickup-attempt-2026-09-09/`: initial/final status, workbench transcript, saved conversation captures, and independent before/after JPEGs.
