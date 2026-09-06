#!/bin/sh
# Run in the GPU worker's isolated environment after installing its CUDA PyTorch build.
set -eu
python -m pip install "git+https://github.com/facebookresearch/sam3.git@660a5e9e1b8b4c02c0ad97229b88a09a6e4ff5b7"
python -m pip install "git+https://github.com/ByteDance-Seed/Depth-Anything-3.git@3d835ec1a5802d64a8b8b15f817a1ab54809bfe4"
