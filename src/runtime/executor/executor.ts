import type { Bot } from "mineflayer";
import type { RuntimeConfig } from "../../shared/config.js";
import type { BotAction } from "../../shared/protocol.js";
import { makeId, summarizeError, toFixedNumber } from "../../shared/utils.js";
import { ActionHandlers } from "./actionHandlers.js";

type VerificationStatus = "true" | "false" | "unknown";

interface QueueItem {
  action: BotAction;
  lane: "urgent" | "main" | "idle";
}

interface CurrentActionState {
  action: BotAction;
  lane: "urgent" | "main" | "idle";
  startedAt: number;
  controller: AbortController;
  timeout: NodeJS.Timeout;
  stepIndex: number;
  cancelReason?: string;
}

interface QueueSnapshot {
  planId: string | null;
  stepIndex: number;
  state: ExecutorStatus["state"];
  currentAction: string | null;
  currentLane: "urgent" | "main" | "idle" | null;
  currentStartedAt: number | null;
  currentElapsedMs: number | null;
  mainQueueSize: number;
  urgentQueueSize: number;
  mainQueue: string[];
  urgentQueue: string[];
}

export interface ExecutorStatus {
  planId: string | null;
  stepIndex: number;
  currentAction: string | null;
  state: "idle" | "running" | "blocked" | "canceling" | "error";
}

export class Executor {
  private readonly mainQueue: BotAction[] = [];
  private readonly urgentQueue: BotAction[] = [];
  private current: CurrentActionState | null = null;
  private currentPlanId: string | null = null;
  private stepIndex = 0;
  private state: ExecutorStatus["state"] = "idle";
  private running = false;
  private failureTimestamps: number[] = [];
  private idleBehavior: "wander" | "guard_home" | "standby";

  constructor(
    private readonly bot: Bot,
    private readonly config: RuntimeConfig,
    private readonly handlers: ActionHandlers,
    private readonly emitEvent: (event: string, data: Record<string, unknown>, salience?: number) => void,
  ) {
    this.idleBehavior = config.idleBehavior;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    void this.runLoop();
  }

  getStatus(): ExecutorStatus {
    return {
      planId: this.currentPlanId,
      stepIndex: this.stepIndex,
      currentAction: this.current ? this.actionSummary(this.current.action) : null,
      state: this.state,
    };
  }

  setIdleBehavior(behavior: "wander" | "guard_home" | "standby"): void {
    this.idleBehavior = behavior;
    this.emitEvent("queue_idle_behavior", { behavior, queue: this.getQueueSnapshot() }, 0.5);
  }

  replaceQueue(actions: BotAction[], planId?: string, reason?: string): void {
    this.mainQueue.length = 0;
    this.mainQueue.push(...actions);
    this.currentPlanId = planId ?? makeId("plan");
    this.stepIndex = 0;

    this.emitEvent("queue_replaced", {
      planId: this.currentPlanId,
      reason: reason ?? "unspecified",
      queueSize: this.mainQueue.length,
      queue: this.getQueueSnapshot(),
    }, 0.75);

    this.cancelCurrent(`replaceQueue:${reason ?? "unspecified"}`);
  }

  prependActions(actions: BotAction[], priority: "urgent" | "normal", reason?: string): void {
    if (priority === "urgent") {
      this.urgentQueue.unshift(...actions.reverse());
      this.cancelCurrent(`urgent_preempt:${reason ?? "unspecified"}`);
    } else {
      this.mainQueue.unshift(...actions.reverse());
    }

    this.emitEvent("queue_prepended", {
      count: actions.length,
      priority,
      reason: reason ?? "unspecified",
      mainQueueSize: this.mainQueue.length,
      urgentQueueSize: this.urgentQueue.length,
      queue: this.getQueueSnapshot(),
    }, priority === "urgent" ? 0.9 : 0.6);
  }

  cancelCurrent(reason?: string): void {
    if (!this.current) {
      return;
    }
    this.state = "canceling";
    this.current.cancelReason = reason ?? "cancelCurrent";
    this.current.controller.abort();
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      const next = this.dequeue();
      await this.execute(next);
    }
  }

  private dequeue(): QueueItem {
    if (this.urgentQueue.length > 0) {
      const action = this.urgentQueue.shift()!;
      return { action, lane: "urgent" };
    }

    if (this.mainQueue.length > 0) {
      const action = this.mainQueue.shift()!;
      return { action, lane: "main" };
    }

    return {
      action: { type: "idle", behavior: this.idleBehavior },
      lane: "idle",
    };
  }

  private async execute(item: QueueItem): Promise<void> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const actionTimeoutMs = this.resolveActionTimeout(item.action);
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      if (this.current && this.current.controller === controller) {
        this.current.cancelReason = `timeout:${actionTimeoutMs}ms`;
      }
      controller.abort();
    }, actionTimeoutMs);

    this.current = {
      action: item.action,
      lane: item.lane,
      startedAt,
      controller,
      timeout,
      stepIndex: this.stepIndex,
    };

    const before = this.captureBotState();
    this.state = item.lane === "idle" ? "idle" : "running";

    this.emitEvent(
      "action_started",
      {
        action: this.actionSummary(item.action),
        planId: this.currentPlanId,
        stepIndex: this.stepIndex,
        lane: item.lane,
        queue: this.getQueueSnapshot(),
      },
      0.7,
    );

    try {
      const result = await this.handlers.run(item.action, controller.signal);

      const after = this.captureBotState();
      const verification = this.verify(item.action, before, after);

      this.emitEvent(
        "action_done",
        {
          action: this.actionSummary(item.action),
          planId: this.currentPlanId,
          stepIndex: this.stepIndex,
          result,
          verification,
          queue: this.getQueueSnapshot(),
        },
        0.65,
      );

      if (item.lane === "main") {
        this.stepIndex += 1;
      }

      this.state = this.mainQueue.length === 0 && this.urgentQueue.length === 0 ? "idle" : "running";

      if (
        item.lane === "main" &&
        this.mainQueue.length === 0 &&
        this.urgentQueue.length === 0 &&
        this.currentPlanId
      ) {
        this.emitEvent(
          "plan_completed",
          {
            planId: this.currentPlanId,
            totalSteps: this.stepIndex,
            lastAction: this.actionSummary(item.action),
            lastResult: result,
            queue: this.getQueueSnapshot(),
          },
          0.95,
        );
      }
    } catch (error) {
      const message = summarizeError(error);
      const canceled = controller.signal.aborted;
      const cancelReason = this.current?.cancelReason ?? (timedOut ? `timeout:${actionTimeoutMs}ms` : "aborted");
      const timeoutAbort = canceled && (timedOut || cancelReason.startsWith("timeout:"));

      if (canceled && !timeoutAbort) {
        this.emitEvent(
          "action_canceled",
          {
            action: this.actionSummary(item.action),
            planId: this.currentPlanId,
            stepIndex: this.stepIndex,
            reason: cancelReason,
            queue: this.getQueueSnapshot(),
          },
          0.8,
        );
      } else {
        const effectiveMessage = timeoutAbort
          ? `action_timeout:${this.actionSummary(item.action)}:${cancelReason.replace(/^timeout:/, "")}`
          : message;
        this.state = "error";
        this.emitEvent(
          "action_failed",
          {
            action: this.actionSummary(item.action),
            planId: this.currentPlanId,
            stepIndex: this.stepIndex,
            error: effectiveMessage,
            queue: this.getQueueSnapshot(),
          },
          0.95,
        );

        this.noteFailure();

        if (effectiveMessage.includes("path") || effectiveMessage.includes("goal")) {
          this.emitEvent("pathfinder_failed", { error: effectiveMessage, action: this.actionSummary(item.action) }, 0.9);
        }
      }
    } finally {
      clearTimeout(timeout);
      this.current = null;
      if (this.state !== "error") {
        this.state = this.mainQueue.length === 0 && this.urgentQueue.length === 0 ? "idle" : "running";
      }
    }
  }

  private resolveActionTimeout(action: BotAction): number {
    if (action.type === "wait") {
      return Math.min(this.config.actionTimeoutMs, action.ms + 2_000);
    }
    if (action.type === "follow") {
      return Math.max(this.config.actionTimeoutMs, 120_000);
    }
    // Navigation actions need at least 60s — pathfinding to a far target can take time.
    if (action.type === "goto" || action.type === "flee") {
      return Math.max(this.config.actionTimeoutMs, 60_000);
    }
    // Tools do their own internal pathfinding loops; give them 3 minutes minimum.
    if (action.type === "run_tool") {
      return Math.max(this.config.actionTimeoutMs, 180_000);
    }
    return this.config.actionTimeoutMs;
  }

  private noteFailure(): void {
    const now = Date.now();
    this.failureTimestamps.push(now);
    const threshold = now - this.config.repeatedFailureWindowMs;
    this.failureTimestamps = this.failureTimestamps.filter((ts) => ts >= threshold);

    if (this.failureTimestamps.length >= this.config.repeatedFailureThreshold) {
      this.emitEvent(
        "repeated_failure",
        {
          count: this.failureTimestamps.length,
          windowMs: this.config.repeatedFailureWindowMs,
          threshold: this.config.repeatedFailureThreshold,
          queue: this.getQueueSnapshot(),
        },
        1,
      );
      this.failureTimestamps = [];
    }
  }

  getQueueSnapshot(limit = 12): QueueSnapshot {
    const now = Date.now();
    return {
      planId: this.currentPlanId,
      stepIndex: this.stepIndex,
      state: this.state,
      currentAction: this.current ? this.actionSummary(this.current.action) : null,
      currentLane: this.current?.lane ?? null,
      currentStartedAt: this.current?.startedAt ?? null,
      currentElapsedMs: this.current ? now - this.current.startedAt : null,
      mainQueueSize: this.mainQueue.length,
      urgentQueueSize: this.urgentQueue.length,
      mainQueue: this.summarizeQueue(this.mainQueue, limit),
      urgentQueue: this.summarizeQueue(this.urgentQueue, limit),
    };
  }

  private summarizeQueue(actions: BotAction[], limit: number): string[] {
    const safeLimit = Math.max(1, limit);
    const entries = actions.slice(0, safeLimit).map((action) => this.actionSummary(action));
    if (actions.length > safeLimit) {
      entries.push(`...(+${actions.length - safeLimit} more)`);
    }
    return entries;
  }

  private captureBotState() {
    const pos = this.bot.entity.position;
    return {
      pos: {
        x: toFixedNumber(pos.x),
        y: toFixedNumber(pos.y),
        z: toFixedNumber(pos.z),
      },
      inventory: this.bot.inventory
        .items()
        .map((item) => ({ name: item.name, count: item.count }))
        .slice(0, 24),
    };
  }

  private actionSummary(action: BotAction): string {
    switch (action.type) {
      case "say":
        return `say:${action.message.slice(0, 24)}`;
      case "wait":
        return `wait:${action.ms}`;
      case "goto":
        return `goto:${toFixedNumber(action.x)},${toFixedNumber(action.y)},${toFixedNumber(action.z)}`;
      case "follow":
        return `follow:${action.name}`;
      case "flee":
        return `flee:r${action.radius}`;
      case "run_tool":
        return `run_tool:${action.name}`;
      case "idle":
        return `idle:${action.behavior}`;
    }

    return "unknown_action";
  }

  private verify(action: BotAction, before: { pos: { x: number; y: number; z: number } }, after: { pos: { x: number; y: number; z: number } }): {
    status: VerificationStatus;
    detail: string;
  } {
    if (action.type === "goto") {
      const dx = action.x - after.pos.x;
      const dy = action.y - after.pos.y;
      const dz = action.z - after.pos.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const ok = dist <= (action.radius ?? 1) + 1;
      return {
        status: ok ? "true" : "false",
        detail: ok ? `reached target (dist=${toFixedNumber(dist)})` : `did not reach (dist=${toFixedNumber(dist)})`,
      };
    }

    if (action.type === "follow") {
      const moved =
        Math.abs(after.pos.x - before.pos.x) +
        Math.abs(after.pos.y - before.pos.y) +
        Math.abs(after.pos.z - before.pos.z);
      return {
        status: moved > 1 ? "true" : "unknown",
        detail: moved > 1 ? "position changed while following" : "no measurable follow movement",
      };
    }

    if (action.type === "flee") {
      const beforeDist = Math.sqrt((before.pos.x - action.from.x) ** 2 + (before.pos.z - action.from.z) ** 2);
      const afterDist = Math.sqrt((after.pos.x - action.from.x) ** 2 + (after.pos.z - action.from.z) ** 2);
      const ok = afterDist > beforeDist;
      return {
        status: ok ? "true" : "false",
        detail: ok ? `distance increased (${toFixedNumber(beforeDist)}->${toFixedNumber(afterDist)})` : "flee did not increase distance",
      };
    }

    return {
      status: "unknown",
      detail: "no deterministic verification",
    };
  }
}
