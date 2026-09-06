# Proposed perception image delivery

This extension is not applied. Automatic approval review rejected the proposed edit because delivering segmentation/depth preview images to external agents needs explicit authorization for that payload and destination.

## Reviewable change

- After an explicit `perceive` tool call, return the generated PNG preview as an MCP image block to the connected MCP client, alongside source frame ID, capture time, model/version, units, dimensions, and result metadata.
- For the built-in custom loop, attach that same preview as an image message only when the selected provider is configured for vision.
- The recipient is the agent/model provider selected by the operator. The preview can reveal the camera scene. There is no background upload or new inference request.
- Preserve the input frame and structured result as local artifacts for matching the preview to its source.
- Keep remote inference subject to the existing endpoint configuration and operator-approved compute budget.

Current camera capture tools, the workbench perception preview, and Rerun logging remain implemented. The special image-channel conversion for `perceive` is the pending extension.
