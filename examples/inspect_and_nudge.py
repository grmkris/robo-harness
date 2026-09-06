"""Use only after the operator enables the intended backend."""
from robo_harness.client import Robot

with Robot() as robot:
    state=robot.observe()
    print("Backend:",state["backend"],"joints:",state["measured"])
    result=robot.move(target={"shoulder_pan":state["measured"]["shoulder_pan"]+1},duration_s=1)
    print("Measured result:",result["status"],result["residual"])
