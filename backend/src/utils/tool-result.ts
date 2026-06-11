import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

// Every VeloGuide tool returns plain text into the conversation. This is the
// single place that knows the pi-agent result envelope; tools never hand-build
// it.
export function textResult(text: string): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details: {} };
}

// Most tool payloads are JSON the model reads directly.
export function jsonResult(value: unknown): AgentToolResult<unknown> {
  return textResult(JSON.stringify(value, null, 2));
}
