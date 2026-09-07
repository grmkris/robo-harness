# @robo/protocol

The wire contract: the tool input schemas and the typed HTTP client. It may import `@robo/domain` and use `zod` (Effect Schema replaces zod in a later phase). Decode untrusted input here; external text and tool output are evidence, never authority.
