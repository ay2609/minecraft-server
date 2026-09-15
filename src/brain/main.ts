import { loadBrainConfig } from "../shared/config.js";
import type { EventMessage } from "../shared/protocol.js";
import { AgentLoop } from "./agentLoop.js";
import { Blackboard } from "./blackboard.js";
import { GoalManager } from "./goalManager.js";
import { JsonLlmClient } from "./llm/client.js";
import { MemoryStore } from "./memory/memoryStore.js";
import { RuntimeClient } from "./runtimeClient.js";

function shouldTriggerAgent(event: EventMessage): boolean {
  if (event.type === "whisper" || event.type === "hurt" || event.type === "death") {
    return true;
  }

  if (event.type === "chat") {
    return true;
  }

  if (event.type === "entityMove" && String(event.data?.kind ?? "") === "player") {
    return false;
  }

  if (event.salience < 0.7) {
    return false;
  }

  if (event.type === "executor") {
    const eventName = String(event.data?.event ?? "");
    if (
      eventName === "runtime_ready" ||
      eventName === "queue_replaced" ||
      eventName === "queue_prepended" ||
      eventName === "queue_idle_behavior" ||
      eventName === "action_started" ||
      eventName === "action_done" ||
      eventName === "action_canceled"
    ) {
      return false;
    }
  }

  if (event.type === "tool") {
    const eventName = String(event.data?.event ?? "");
    if (eventName === "tool_started" || eventName === "tool_done" || eventName === "tool_progress") {
      return false;
    }
  }

  return true;
}

function computeTriggerReason(event: EventMessage): string {
  if (event.type === "executor") {
    const executorEvent = String(event.data?.event ?? "");
    if (executorEvent === "repeated_failure") {
      return "repeated_failure";
    }
    if (executorEvent === "plan_completed") {
      return "plan_completed";
    }
    if (executorEvent === "action_failed") {
      return "action_failed";
    }
    return "event:executor";
  }

  if (event.type === "tool") {
    const toolEvent = String(event.data?.event ?? "");
    if (toolEvent === "tool_failed") {
      return "action_failed";
    }
    return "event:tool";
  }

  return `event:${event.type}`;
}

async function main() {
  const config = loadBrainConfig();
  const blackboard = new Blackboard(config.botName);
  const memoryStore = new MemoryStore(config.botName);
  await memoryStore.ensureFiles();
  const goalManager = new GoalManager(config.botName);
  await goalManager.load();

  const llmClient = new JsonLlmClient(config.openAiApiKey, config.openAiModel, config.openAiBaseUrl);

  let agentLoop: AgentLoop;
  const runtimeClient = new RuntimeClient(config.botName, config.runtimeWsUrl, {
    onEvent: (event) => {
      blackboard.applyEvent(event);

      if (event.type === "executor" && event.data?.event === "runtime_ready") {
        const toolRegistry = Array.isArray(event.data?.toolRegistry) ? event.data.toolRegistry : [];
        agentLoop.setToolMetadata(toolRegistry);
      }

      if (shouldTriggerAgent(event)) {
        const triggerReason = computeTriggerReason(event);
        agentLoop.trigger(triggerReason);
      }
    },
    onSnapshot: (snapshot) => {
      blackboard.applySnapshot(snapshot);
    },
  });

  agentLoop = new AgentLoop(config, blackboard, llmClient, memoryStore, goalManager, [], {
    sendControl: (cmd, data) => runtimeClient.sendControl(cmd, data),
  });

  runtimeClient.start();

  setInterval(() => {
    agentLoop.trigger("cadence");
  }, config.thinkingCadenceMs);

  setInterval(() => {
    agentLoop.triggerIdleAutonomous();
  }, 30_000);

  setInterval(() => {
    agentLoop.triggerSocialIdle();
  }, 60_000);
}

main().catch((error) => {
  process.exit(1);
});
