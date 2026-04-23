import { readFile } from "node:fs/promises";
import type { Agent, AgentEvent, AgentRequest } from "../types.js";

export class NoneAgent implements Agent {
  async *answer(req: AgentRequest): AsyncIterable<AgentEvent> {
    const askContext = await readFile(`${req.workspacePath}/ASK_CONTEXT.md`, "utf8");
    yield {
      type: "text",
      text: `Workspace: ${req.workspacePath}\n\n${askContext}`,
    };
    yield { type: "done", exitCode: 0 };
  }
}
