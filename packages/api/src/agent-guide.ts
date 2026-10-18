import { readFileSync } from "node:fs";

const AGENT_GUIDE_URL = new URL("../../../docs/agent-guide.md", import.meta.url);

function readAgentGuide(): string {
  try {
    return readFileSync(AGENT_GUIDE_URL, "utf8");
  } catch (cause) {
    // The guide is a document, not code: it must be copied into the runtime
    // image beside packages/api/dist. Fail loudly with the path that is missing.
    throw new Error(
      `Cannot read the agent guide at ${AGENT_GUIDE_URL.pathname}. ` +
        "The runtime image must include docs/agent-guide.md.",
      { cause },
    );
  }
}

/**
 * The agent guide served at `/docs/agent-guide.md` (KTK-155). The source is the
 * document at the repository root: it is edited as a document and read here,
 * never duplicated into code.
 */
export const agentGuideMarkdown = readAgentGuide();
