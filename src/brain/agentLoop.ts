import { readFile } from "node:fs/promises";
import path from "node:path";
import type { BrainConfig } from "../shared/config.js";
import type { BotAction } from "../shared/protocol.js";
import { sleep } from "../shared/utils.js";
import type { Blackboard } from "./blackboard.js";
import type { GoalManager } from "./goalManager.js";
import type { JsonLlmClient } from "./llm/client.js";
import { AgentOutputSchema, type AgentControl, type AgentOutput, type GoalUpdate } from "./llm/schemas.js";
import type { MemoryStore } from "./memory/memoryStore.js";

interface ControlSender {
  sendControl: (
    cmd: "replaceQueue" | "prependActions" | "cancelCurrent" | "setIdleBehavior" | "requestSnapshot",
    data: Record<string, unknown>,
  ) => Promise<boolean>;
}

const CONTEXT_PROMPT_PATH = path.resolve("CONTEXT.md");
const GAME_KNOWLEDGE_PATH = path.resolve("GAME_KNOWLEDGE.md");
const FAILURE_OVERRIDE_WINDOW_MS = 20_000;
const IDLE_AUTONOMOUS_COOLDOWN_MS = 30_000;
const SOCIAL_IDLE_COOLDOWN_MS = 60_000;
const SOCIAL_IDLE_SPEAK_WINDOW_MS = 5 * 60 * 1000;
const SOCIAL_IDLE_WHEN_BUSY_COOLDOWN_MS = 20_000;
const LOW_PRIORITY_RERUN_DEBOUNCE_MS = 100;
// Re-read CONTEXT.md from disk at most once every 30s. Avoids 2 disk reads per LLM cycle
// while still supporting hot-reload for prompt iteration during development.
const SYSTEM_PROMPT_CACHE_TTL_MS = 30_000;

export class AgentLoop {
  private running = false;
  private rerun = false;
  private rerunReason: string | null = null;
  private lastRunAt = 0;
  private lastMaterialTs = 0;
  private lastSnapshotRequestAt = 0;
  private lastControlSignature = "";
  private lastControlAt = 0;
  private lastReplaceAt = 0;
  private lastCancelAt = 0;
  private toolMetadata: unknown[];
  private lastIdleAutonomousAt = 0;
  private lastSocialIdleAt = 0;
  private lastSocialBusySkipAt = 0;
  private cachedSystemPrompt: string | null = null;
  private promptCachedAt = 0;
  private readonly lastTriggerAtByReason = new Map<string, number>();

  constructor(
    private readonly config: BrainConfig,
    private readonly blackboard: Blackboard,
    private readonly llm: JsonLlmClient,
    private readonly memoryStore: MemoryStore,
    private readonly goalManager: GoalManager,
    toolMetadata: unknown[],
    private readonly control: ControlSender,
  ) {
    this.toolMetadata = toolMetadata;
  }

  setToolMetadata(metadata: unknown[]): void {
    this.toolMetadata = Array.isArray(metadata) ? metadata : [];
  }

  trigger(reason: string): void {
    const now = Date.now();
    if (this.shouldThrottleTrigger(reason, now)) {
      return;
    }

    if (this.running) {
      if (reason === "cadence") {
        return;
      }
      this.rerun = true;
      if (!this.rerunReason || this.reasonPriority(reason) > this.reasonPriority(this.rerunReason)) {
        this.rerunReason = reason;
      }
      return;
    }

    if (!this.isHighPriorityReason(reason) && now - this.lastRunAt < this.config.thinkingMinGapMs) {
      return;
    }

    void this.run(reason);
  }

  triggerIdleAutonomous(): void {
    const now = Date.now();
    if (now - this.lastIdleAutonomousAt < IDLE_AUTONOMOUS_COOLDOWN_MS) {
      return;
    }
    if (!this.blackboard.isIdle()) {
      return;
    }
    this.lastIdleAutonomousAt = now;
    this.trigger("idle_autonomous");
  }

  triggerSocialIdle(): void {
    const now = Date.now();
    if (now - this.lastSocialIdleAt < SOCIAL_IDLE_COOLDOWN_MS) {
      return;
    }
    if (!this.blackboard.isIdle()) {
      if (now - this.lastSocialBusySkipAt > SOCIAL_IDLE_WHEN_BUSY_COOLDOWN_MS) {
        this.lastSocialBusySkipAt = now;
      }
      return;
    }
    if (this.blackboard.hasPendingDirectedChats()) {
      return;
    }
    // Check if any players are nearby in the last snapshot
    const context = this.blackboard.getReactiveContext();
    const nearbyPlayers = (context as Record<string, unknown>);
    // Use snapshot entities to detect players
    const snapshot = this.blackboard.getPlanStatus();
    // We check via getAgentContext but we only need entities — use a simpler approach:
    // triggerSocialIdle checks if the bot hasn't spoken recently and players are nearby
    const hasSpokeRecently = this.blackboard.wasBotMessageRecentlySent("", SOCIAL_IDLE_SPEAK_WINDOW_MS);
    // We can't easily check players from here without exposing more blackboard API,
    // so we rely on the agent to decide whether to chat when triggered
    void nearbyPlayers;
    if (!hasSpokeRecently) {
      this.lastSocialIdleAt = now;
      this.trigger("social_idle");
    }
  }

  private async run(reason: string): Promise<void> {
    const runStartedAt = Date.now();
    this.running = true;
    this.lastRunAt = runStartedAt;

    try {
      if (!this.isHighPriorityReason(reason) && !this.blackboard.hasNewMaterialSince(this.lastMaterialTs)) {
        return;
      }
      this.lastMaterialTs = runStartedAt;

      if (!this.llm.enabled()) {
        return;
      }

      const [persona, relationships] = await Promise.all([
        this.memoryStore.readPersona(),
        this.memoryStore.readRelationships(),
      ]);
      const metadata = this.memoryStore.readMetadata();
      const goals = this.goalManager.getActive();
      const context = this.blackboard.getAgentContext(persona, relationships, metadata, this.toolMetadata, goals);
      const systemPrompt = await this.loadSystemPrompt();
      const contextSummary = {
        hasSelf: Boolean(context.self),
        recentChatCount: context.recentChat.length,
        pendingDirectedChatsCount: Array.isArray((context as Record<string, unknown>).pendingDirectedChats)
          ? ((context as Record<string, unknown>).pendingDirectedChats as unknown[]).length
          : 0,
        recentSalientEventsCount: context.recentSalientEvents.length,
        recentFailuresCount: context.recentFailures.length,
        availableToolCount: Array.isArray(context.availableTools) ? context.availableTools.length : 0,
        planStatus: context.planStatus ?? null,
        queueStatus: context.queueStatus ?? null,
        activeGoalCount: goals.length,
      };
      const promptStateSignature = this.buildExecutionSignature(context.planStatus, context.queueStatus);

      const skipReason = this.shouldSkipReasonByContext(reason, contextSummary);
      if (skipReason) {
        return;
      }

      if (!context.self) {
        const now = Date.now();
        if (now - this.lastSnapshotRequestAt > 2_000) {
          this.lastSnapshotRequestAt = now;
          await this.control.sendControl("requestSnapshot", {});
        }
        return;
      }

      const userPrompt = JSON.stringify(stripNullFields({ reason, context }), null, 2);
      const outputRaw = await this.llm.completeJson({
        task: "agent",
        systemPrompt,
        userPrompt,
        schema: AgentOutputSchema,
        temperature: 0.35,
      });

      if (!outputRaw) {
        return;
      }

      const parsed = AgentOutputSchema.safeParse(outputRaw);
      if (!parsed.success) {
        return;
      }

      let outputToApply = parsed.data;
      const staleResult = this.handleStaleOutput(outputToApply, promptStateSignature);
      if (staleResult.stale) {
        outputToApply = staleResult.output;
        this.queueRerun("stale_context");
        if (staleResult.noOpAfterDrop) {
          return;
        }
      }

      const goalDriven = Boolean(outputToApply.goalUpdates && outputToApply.goalUpdates.length > 0);
      await this.applyOutput(outputToApply, reason, goalDriven);
      if (outputToApply.goalUpdates && outputToApply.goalUpdates.length > 0) {
        await this.applyGoalUpdates(outputToApply.goalUpdates);
      }
    } catch {
    } finally {
      this.running = false;
      if (this.rerun) {
        const nextReason = this.rerunReason ?? "rerun";
        this.rerun = false;
        this.rerunReason = null;
        // High-priority events (chat, plan_completed, etc.) fire immediately.
        // Low-priority reruns get a small debounce to prevent tight loops.
        const delay = this.isHighPriorityReason(nextReason) ? 0 : LOW_PRIORITY_RERUN_DEBOUNCE_MS;
        if (delay > 0) await sleep(delay);
        if (!this.running) {
          void this.run(nextReason);
        }
      }
    }
  }

  private shouldThrottleTrigger(reason: string, now: number): boolean {
    const minGapMs = this.triggerMinGapMs(reason);
    if (minGapMs <= 0) {
      return false;
    }

    const last = this.lastTriggerAtByReason.get(reason) ?? 0;
    if (now - last < minGapMs) {
      return true;
    }

    this.lastTriggerAtByReason.set(reason, now);
    return false;
  }

  private triggerMinGapMs(reason: string): number {
    switch (reason) {
      case "social_idle":
        return 8_000;
      case "cadence":
        return Math.max(1_000, this.config.thinkingCadenceMs / 2);
      case "event:tool":
        return 1_000;
      case "event:executor":
        return 700;
      default:
        return 0;
    }
  }

  private reasonPriority(reason: string): number {
    if (reason === "event:chat" || reason === "event:whisper") {
      return this.blackboard.hasPendingDirectedChats() ? 100 : 85;
    }

    switch (reason) {
      case "plan_completed":
        return 90;
      case "action_failed":
      case "repeated_failure":
        return 88;
      case "stale_context":
        return 86;
      case "event:death":
      case "event:hurt":
        return 84;
      case "event:tool":
      case "event:executor":
        return 70;
      case "idle_autonomous":
        return 52;
      case "event:health":
        return 45;
      case "social_idle":
        return 20;
      case "cadence":
        return 10;
      default:
        return 35;
    }
  }

  private shouldSkipReasonByContext(
    reason: string,
    contextSummary: {
      pendingDirectedChatsCount: number;
      recentFailuresCount: number;
      queueStatus: unknown;
      planStatus: unknown;
    },
  ): string | null {
    const pendingDirected = contextSummary.pendingDirectedChatsCount > 0;
    const hasRecentFailures = contextSummary.recentFailuresCount > 0;
    const queueBusy = this.isQueueBusy(contextSummary.queueStatus, contextSummary.planStatus);

    if (reason === "social_idle" && (queueBusy || pendingDirected)) {
      return pendingDirected ? "pending_directed_chat" : "queue_busy";
    }

    if (reason === "cadence" && queueBusy && !pendingDirected && !hasRecentFailures) {
      return "queue_busy_low_value";
    }

    if (reason === "idle_autonomous" && queueBusy) {
      return "queue_busy";
    }

    return null;
  }

  private isQueueBusy(queueStatus: unknown, planStatus: unknown): boolean {
    const queue = queueStatus && typeof queueStatus === "object" && !Array.isArray(queueStatus)
      ? (queueStatus as Record<string, unknown>)
      : {};
    const plan = planStatus && typeof planStatus === "object" && !Array.isArray(planStatus)
      ? (planStatus as Record<string, unknown>)
      : {};

    const state = typeof queue.state === "string" ? queue.state : "";
    const mainQueueSize = typeof queue.mainQueueSize === "number" ? queue.mainQueueSize : 0;
    const urgentQueueSize = typeof queue.urgentQueueSize === "number" ? queue.urgentQueueSize : 0;
    const currentLane = typeof queue.currentLane === "string" ? queue.currentLane : "";
    const queueAction = typeof queue.currentAction === "string" ? queue.currentAction : "";
    const planAction = typeof plan.currentAction === "string" ? plan.currentAction : "";
    const executorState = typeof plan.executorState === "string" ? plan.executorState : "";

    if (state === "running" || state === "canceling" || state === "blocked") {
      return true;
    }
    if (mainQueueSize > 0 || urgentQueueSize > 0) {
      return true;
    }
    if (currentLane === "main" && queueAction.length > 0 && !queueAction.startsWith("idle:")) {
      return true;
    }
    if (executorState === "running" || executorState === "canceling" || executorState === "blocked") {
      return true;
    }
    if (planAction.length > 0 && !planAction.startsWith("idle:")) {
      return true;
    }

    return false;
  }

  private isHighPriorityReason(reason: string): boolean {
    return (
      reason === "event:chat" ||
      reason === "event:whisper" ||
      reason === "event:hurt" ||
      reason === "event:death" ||
      reason === "stale_context" ||
      reason === "idle_autonomous" ||
      reason === "action_failed" ||
      reason === "repeated_failure" ||
      reason === "plan_completed"
    );
  }

  private async applyGoalUpdates(updates: GoalUpdate[]): Promise<void> {
    for (const update of updates) {
      switch (update.op) {
        case "add":
          this.goalManager.add(update.description, update.priority, update.source, update.notes);
          break;
        case "complete":
          this.goalManager.complete(update.id, update.notes);
          break;
        case "fail":
          this.goalManager.fail(update.id, update.notes);
          break;
        case "update":
          this.goalManager.update(update.id, {
            description: update.description,
            priority: update.priority,
            notes: update.notes,
          });
          break;
      }
    }
    await this.goalManager.persist();
  }

  private async applyOutput(output: AgentOutput, reason: string, goalDriven: boolean): Promise<{
    controlSent: boolean;
    controlCmd: string | null;
    controlSuppressedReason: string | null;
    sayQueued: number;
    sayPriority: "urgent" | "normal" | null;
    memoryUpdated: boolean;
  }> {
    let controlSent = false;
    let controlCmd: string | null = null;
    let controlSuppressedReason: string | null = null;
    let sayQueued = 0;
    let sayPriority: "urgent" | "normal" | null = null;
    let memoryUpdated = false;
    const sayQueuePriority = this.resolveSayQueuePriority(reason);

    const sayActions: BotAction[] =
      output.say && output.say.length > 0
        ? output.say
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .slice(0, 4)
            .map((message) => (message.length <= 180 ? message : `${message.slice(0, 177)}...`))
            .map((message) => ({ type: "say" as const, message }))
        : [];

    let sayMergedIntoReplace = false;

    if (output.control) {
      const control = output.control as AgentControl;
      const { cmd, ...data } = control;
      controlCmd = cmd;

      let dataToSend: Record<string, unknown> = data as Record<string, unknown>;
      if (cmd === "replaceQueue" && sayActions.length > 0) {
        const planActions = Array.isArray(dataToSend.actions) ? (dataToSend.actions as BotAction[]) : [];
        dataToSend = { ...dataToSend, actions: [...sayActions, ...planActions] };
      }

      const suppressReason = this.shouldSuppressControl(cmd, dataToSend, goalDriven);
      if (suppressReason) {
        controlSuppressedReason = suppressReason;
      } else {
        const ok = await this.control.sendControl(cmd, dataToSend);
        if (ok) {
          controlSent = true;
          this.noteControlSent(cmd, dataToSend);
          if (cmd === "replaceQueue" && sayActions.length > 0) {
            sayMergedIntoReplace = true;
            sayQueued = sayActions.length;
            sayPriority = sayQueuePriority;
            for (const action of sayActions) {
              if (action.type === "say") {
                this.blackboard.noteBotUtterance(action.message, Date.now(), "agent");
              }
            }
          }
        }
      }
    }

    if (sayActions.length > 0 && !sayMergedIntoReplace) {
      const ok = await this.control.sendControl("prependActions", {
        actions: sayActions,
        priority: sayQueuePriority,
        reason: "agent_say",
      });
      if (ok) {
        for (const action of sayActions) {
          if (action.type === "say") {
            this.blackboard.noteBotUtterance(action.message, Date.now(), "agent");
          }
        }
        sayQueued += sayActions.length;
        sayPriority = sayQueuePriority;
      }
    }

    if (output.memoryUpdate) {
      if (!output.memoryUpdate.mode || !output.memoryUpdate.content) {
        return { controlSent, controlCmd, controlSuppressedReason, sayQueued, sayPriority, memoryUpdated };
      }
      await this.memoryStore.applyRelationshipUpdate({
        mode: output.memoryUpdate.mode,
        content: output.memoryUpdate.content,
      });
      memoryUpdated = true;
    }

    return {
      controlSent,
      controlCmd,
      controlSuppressedReason,
      sayQueued,
      sayPriority,
      memoryUpdated,
    };
  }

  private resolveSayQueuePriority(reason: string): "urgent" | "normal" {
    if (reason === "event:chat" || reason === "event:whisper") {
      return "urgent";
    }
    if (this.blackboard.hasPendingDirectedChats()) {
      return "urgent";
    }
    const queueBusy = this.isQueueBusy(this.blackboard.getQueueStatus(), this.blackboard.getPlanStatus());
    return queueBusy ? "normal" : "urgent";
  }

  private handleStaleOutput(
    output: AgentOutput,
    promptStateSignature: string,
  ): {
    stale: boolean;
    output: AgentOutput;
    droppedSayCount: number;
    droppedSetIdleBehavior: boolean;
    noOpAfterDrop: boolean;
  } {
    const liveStateSignature = this.buildExecutionSignature(this.blackboard.getPlanStatus(), this.blackboard.getQueueStatus());
    if (liveStateSignature === promptStateSignature) {
      return {
        stale: false,
        output,
        droppedSayCount: 0,
        droppedSetIdleBehavior: false,
        noOpAfterDrop: false,
      };
    }

    const nextOutput: AgentOutput = { ...output };
    let droppedSayCount = 0;
    let droppedSetIdleBehavior = false;

    if (Array.isArray(nextOutput.say) && nextOutput.say.length > 0) {
      droppedSayCount = nextOutput.say.length;
      delete nextOutput.say;
    }

    if (nextOutput.control?.cmd === "setIdleBehavior") {
      droppedSetIdleBehavior = true;
      delete nextOutput.control;
    }

    const noOpAfterDrop =
      !nextOutput.control &&
      (!nextOutput.say || nextOutput.say.length === 0) &&
      !nextOutput.memoryUpdate &&
      (!nextOutput.goalUpdates || nextOutput.goalUpdates.length === 0);

    return {
      stale: true,
      output: nextOutput,
      droppedSayCount,
      droppedSetIdleBehavior,
      noOpAfterDrop,
    };
  }

  private buildExecutionSignature(planStatus: unknown, queueStatus: unknown): string {
    const plan = planStatus && typeof planStatus === "object" && !Array.isArray(planStatus)
      ? (planStatus as Record<string, unknown>)
      : {};
    const queue = queueStatus && typeof queueStatus === "object" && !Array.isArray(queueStatus)
      ? (queueStatus as Record<string, unknown>)
      : {};

    const list = (value: unknown): string[] => {
      if (!Array.isArray(value)) {
        return [];
      }
      return value
        .slice(0, 12)
        .map((entry) => String(entry))
        .filter((entry) => entry.length > 0);
    };

    return this.stableStringify({
      plan: {
        planId: plan.planId ?? null,
        stepIndex: plan.stepIndex ?? null,
        currentAction: plan.currentAction ?? null,
        executorState: plan.executorState ?? null,
      },
      queue: {
        planId: queue.planId ?? null,
        stepIndex: queue.stepIndex ?? null,
        state: queue.state ?? null,
        currentAction: queue.currentAction ?? null,
        currentLane: queue.currentLane ?? null,
        mainQueueSize: queue.mainQueueSize ?? null,
        urgentQueueSize: queue.urgentQueueSize ?? null,
        mainQueue: list(queue.mainQueue),
        urgentQueue: list(queue.urgentQueue),
      },
    });
  }

  private queueRerun(reason: string): void {
    this.rerun = true;
    if (!this.rerunReason || this.reasonPriority(reason) > this.reasonPriority(this.rerunReason)) {
      this.rerunReason = reason;
    }
  }

  private shouldSuppressControl(
    cmd: "replaceQueue" | "prependActions" | "cancelCurrent" | "setIdleBehavior",
    data: Record<string, unknown>,
    goalDriven = false,
  ): string | null {
    const now = Date.now();
    const signature = this.stableStringify({ cmd, data });
    if (signature === this.lastControlSignature && now - this.lastControlAt < this.config.controlDedupWindowMs) {
      return "duplicate_control_cooldown";
    }

    if (cmd === "cancelCurrent" && now - this.lastCancelAt < this.config.cancelMinGapMs) {
      return "cancel_cooldown";
    }

    if (cmd === "replaceQueue" && !goalDriven) {
      const hasPendingDirectedChats = this.blackboard.hasPendingDirectedChats();
      const hasRecentFailures = this.blackboard.getRecentFailuresSince(now - FAILURE_OVERRIDE_WINDOW_MS).length > 0;
      if (!hasPendingDirectedChats && !hasRecentFailures && now - this.lastReplaceAt < this.config.replaceQueueMinGapMs) {
        return "replace_queue_cooldown";
      }
    }

    return null;
  }

  private noteControlSent(
    cmd: "replaceQueue" | "prependActions" | "cancelCurrent" | "setIdleBehavior",
    data: Record<string, unknown>,
  ): void {
    const now = Date.now();
    this.lastControlAt = now;
    this.lastControlSignature = this.stableStringify({ cmd, data });
    if (cmd === "replaceQueue") {
      this.lastReplaceAt = now;
    }
    if (cmd === "cancelCurrent") {
      this.lastCancelAt = now;
    }
  }

  private stableStringify(value: unknown): string {
    if (value === null || value === undefined) {
      return String(value);
    }
    if (typeof value !== "object") {
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
      return `[${value.map((entry) => this.stableStringify(entry)).join(",")}]`;
    }

    const objectValue = value as Record<string, unknown>;
    const keys = Object.keys(objectValue).sort();
    const parts = keys.map((key) => `${JSON.stringify(key)}:${this.stableStringify(objectValue[key])}`);
    return `{${parts.join(",")}}`;
  }

  private async loadSystemPrompt(): Promise<string> {
    const now = Date.now();
    if (this.cachedSystemPrompt !== null && now - this.promptCachedAt < SYSTEM_PROMPT_CACHE_TTL_MS) {
      return this.cachedSystemPrompt;
    }

    try {
      const prompt = (await readFile(CONTEXT_PROMPT_PATH, "utf8")).trim();
      if (prompt.length === 0) {
        throw new Error("empty CONTEXT.md");
      }
      let systemPrompt = prompt;
      try {
        const gameKnowledge = (await readFile(GAME_KNOWLEDGE_PATH, "utf8")).trim();
        if (gameKnowledge.length > 0) {
          systemPrompt = `${prompt}\n\n---\n\n${gameKnowledge}`;
        }
      } catch {
        // GAME_KNOWLEDGE.md optional — skip if missing
      }
      this.cachedSystemPrompt = systemPrompt;
      this.promptCachedAt = now;
      return systemPrompt;
    } catch {
      const fallback = "You are a Minecraft bot brain. Output strict JSON only.";
      this.cachedSystemPrompt = fallback;
      this.promptCachedAt = now;
      return fallback;
    }
  }
}

function stripNullFields(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(stripNullFields);
  }
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== null && v !== undefined) {
        result[k] = stripNullFields(v);
      }
    }
    return result;
  }
  return value;
}
