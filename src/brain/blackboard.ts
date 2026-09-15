import type { EventMessage, SnapshotMessage } from "../shared/protocol.js";
import type { BotMetadata } from "../shared/botData.js";
import type { Goal } from "./goalManager.js";
import { boundedPush, toFixedNumber } from "../shared/utils.js";

interface ChatEntry {
  id: string;
  ts: number;
  from: string;
  message: string;
  whisper: boolean;
  directed: boolean;
  replied: boolean;
}

interface AlertEntry {
  ts: number;
  topic: string;
  detail: string;
}

interface ConversationEntry {
  ts: number;
  speaker: "player" | "bot";
  name: string;
  message: string;
  source: "chat" | "whisper" | "agent" | "executor";
}

interface CompletedAction {
  ts: number;
  action: string;
  result: string;
  planId?: string;
}

interface CompletedPlanSummary {
  planId: string;
  completedAt: number;
  totalSteps: number;
  lastAction: string;
}

export type BlackboardChatEntry = ChatEntry;
const CHAT_FOLLOWUP_WINDOW_MS = 45_000;
const BOT_UTTERANCE_DEDUP_WINDOW_MS = 2_500;

const EXECUTOR_NOISE_EVENTS = new Set([
  "runtime_ready",
  "queue_replaced",
  "queue_prepended",
  "queue_idle_behavior",
  "action_started",
  "action_done",
  "action_canceled",
]);

const TOOL_NOISE_EVENTS = new Set(["tool_started", "tool_done", "tool_progress"]);

function trimText(value: unknown, max = 180): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const oneLine = value.replace(/\s+/g, " ").trim();
  if (oneLine.length === 0) {
    return undefined;
  }
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 3)}...`;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function chatEntryId(ts: number, from: string, message: string): string {
  return `${ts}:${from.toLowerCase()}:${normalizeText(message)}`;
}

function extractSaidFromExecutorEvent(event: EventMessage): string | undefined {
  if (event.type !== "executor") {
    return undefined;
  }

  const result = event.data.result;
  if (result && typeof result === "object" && typeof (result as Record<string, unknown>).said === "string") {
    return trimText((result as Record<string, unknown>).said, 180);
  }

  const action = trimText(event.data.action, 180);
  if (!action || !action.startsWith("say:")) {
    return undefined;
  }

  return trimText(action.slice(4), 180);
}

function compactQueueSnapshot(data: Record<string, unknown>): Record<string, unknown> | undefined {
  const queue = data.queue;
  if (!queue || typeof queue !== "object" || Array.isArray(queue)) {
    return undefined;
  }

  const queueObj = queue as Record<string, unknown>;
  const list = (value: unknown) =>
    Array.isArray(value)
      ? value
          .slice(0, 10)
          .map((entry) => trimText(entry, 96))
          .filter((entry): entry is string => Boolean(entry))
      : undefined;

  return {
    planId: trimText(queueObj.planId, 72),
    stepIndex: typeof queueObj.stepIndex === "number" ? queueObj.stepIndex : undefined,
    state: trimText(queueObj.state, 24),
    currentAction: trimText(queueObj.currentAction, 96),
    currentLane: trimText(queueObj.currentLane, 24),
    mainQueueSize: typeof queueObj.mainQueueSize === "number" ? queueObj.mainQueueSize : undefined,
    urgentQueueSize: typeof queueObj.urgentQueueSize === "number" ? queueObj.urgentQueueSize : undefined,
    mainQueue: list(queueObj.mainQueue),
    urgentQueue: list(queueObj.urgentQueue),
  };
}

function compactEventData(event: EventMessage): Record<string, unknown> {
  const data = event.data ?? {};

  switch (event.type) {
    case "chat":
    case "whisper":
      return {
        username: trimText(data.username, 32),
        message: trimText(data.message, 180),
        directed: Boolean(data.directed),
      };
    case "executor":
      return {
        event: trimText(data.event, 64),
        action: trimText(data.action, 72),
        planId: trimText(data.planId, 72),
        stepIndex: typeof data.stepIndex === "number" ? data.stepIndex : undefined,
        reason: trimText(data.reason, 180),
        error: trimText(data.error, 220),
        queueSize: typeof data.queueSize === "number" ? data.queueSize : undefined,
        queue: compactQueueSnapshot(data),
      };
    case "tool":
      return {
        event: trimText(data.event, 64),
        tool: trimText(data.tool, 64),
        phase: trimText(data.phase, 64),
        reason: trimText(data.reason, 180),
        error: trimText(data.error, 220),
      };
    case "inventory": {
      const items = Array.isArray(data.items) ? data.items.slice(0, 8) : [];
      return { itemCount: items.length, items };
    }
    default:
      return data;
  }
}

function isMaterialEvent(event: EventMessage): boolean {
  if (event.type === "chat" || event.type === "whisper" || event.type === "hurt" || event.type === "death") {
    return true;
  }

  if (event.type === "executor") {
    const eventName = String(event.data.event ?? "");
    if (EXECUTOR_NOISE_EVENTS.has(eventName)) {
      return false;
    }
    return event.salience >= 0.7 || eventName.includes("failed") || eventName.includes("error");
  }

  if (event.type === "tool") {
    const eventName = String(event.data.event ?? "");
    if (TOOL_NOISE_EVENTS.has(eventName)) {
      return false;
    }
    return event.salience >= 0.7 || eventName.includes("failed");
  }

  return event.salience >= 0.7;
}

export class Blackboard {
  private lastSnapshot: SnapshotMessage["data"] | null = null;
  private readonly botName: string;
  private readonly chatLog: ChatEntry[] = [];
  private readonly conversationHistory: ConversationEntry[] = [];
  private readonly salientEvents: EventMessage[] = [];
  private readonly rollingSummary: string[] = [];
  private readonly reactiveAlerts: AlertEntry[] = [];
  private readonly recentFailures: Array<{ ts: number; detail: string }> = [];
  private readonly completedActions: CompletedAction[] = [];
  private readonly lastDirectedBySender = new Map<string, number>();
  private lastQueueSnapshot: Record<string, unknown> | null = null;
  private lastCompletedPlan: CompletedPlanSummary | null = null;

  constructor(botName = "Scout") {
    this.botName = botName;
  }

  applySnapshot(snapshot: SnapshotMessage): void {
    this.lastSnapshot = snapshot.data;
  }

  applyEvent(event: EventMessage): void {
    boundedPush(this.salientEvents, event, 200);

    const summary = `${new Date(event.ts).toISOString()} ${event.type} s=${toFixedNumber(event.salience, 2)}`;
    boundedPush(this.rollingSummary, summary, 120);

    if (event.type === "chat" || event.type === "whisper") {
      const from = String(event.data.username ?? "unknown");
      const message = String(event.data.message ?? "");
      const senderKey = from.toLowerCase();
      const explicitDirected =
        event.type === "whisper" || Boolean(event.data.directed) || message.toLowerCase().includes(this.botName.toLowerCase());
      const previousDirectedTs = this.lastDirectedBySender.get(senderKey) ?? 0;
      const contextualDirected = event.ts - previousDirectedTs <= CHAT_FOLLOWUP_WINDOW_MS;
      const directed = explicitDirected || contextualDirected;

      if (directed) {
        this.lastDirectedBySender.set(senderKey, event.ts);
      }

      boundedPush(
        this.chatLog,
        {
          id: chatEntryId(event.ts, from, message),
          ts: event.ts,
          from,
          message,
          whisper: event.type === "whisper",
          directed,
          replied: false,
        },
        60,
      );

      boundedPush(
        this.conversationHistory,
        {
          ts: event.ts,
          speaker: "player",
          name: from,
          message,
          source: event.type === "whisper" ? "whisper" : "chat",
        },
        120,
      );
    }

    if (event.type === "executor") {
      const eventName = String(event.data.event ?? "");
      const queueSnapshot = compactQueueSnapshot(event.data ?? {});
      if (queueSnapshot) {
        this.lastQueueSnapshot = queueSnapshot;
      }

      if (eventName.includes("failed")) {
        boundedPush(
          this.recentFailures,
          {
            ts: event.ts,
            detail: JSON.stringify(event.data),
          },
          40,
        );
      }

      if (eventName === "action_done") {
        const said = extractSaidFromExecutorEvent(event);
        if (said) {
          this.noteBotUtterance(said, event.ts, "executor");
        }

        const actionLabel = trimText(event.data.action, 120) ?? "unknown";
        const resultObj = event.data.result;
        const resultStr = resultObj
          ? trimText(typeof resultObj === "string" ? resultObj : JSON.stringify(resultObj), 200) ?? ""
          : "";
        const planId = trimText(event.data.planId, 72);
        boundedPush(
          this.completedActions,
          { ts: event.ts, action: actionLabel, result: resultStr, planId: planId ?? undefined },
          30,
        );
      }

      if (eventName === "plan_completed") {
        this.lastCompletedPlan = {
          planId: trimText(event.data.planId, 72) ?? "unknown",
          completedAt: event.ts,
          totalSteps: typeof event.data.totalSteps === "number" ? event.data.totalSteps : 0,
          lastAction: trimText(event.data.lastAction, 120) ?? "unknown",
        };
      }
    }
  }

  noteBotUtterance(message: string, ts = Date.now(), source: "agent" | "executor" = "agent"): void {
    const clean = trimText(message, 180);
    if (!clean) {
      return;
    }

    if (this.wasBotMessageRecentlySent(clean, BOT_UTTERANCE_DEDUP_WINDOW_MS)) {
      return;
    }

    boundedPush(
      this.conversationHistory,
      {
        ts,
        speaker: "bot",
        name: this.botName,
        message: clean,
        source,
      },
      120,
    );

    for (const entry of this.chatLog) {
      if (entry.directed && !entry.replied && entry.ts <= ts) {
        entry.replied = true;
      }
    }
  }

  hasPendingDirectedChats(): boolean {
    return this.chatLog.some((entry) => entry.directed && !entry.replied);
  }

  getPendingDirectedChats(max = 8): Array<{ id: string; ts: number; from: string; message: string; whisper: boolean }> {
    return this.chatLog
      .filter((entry) => entry.directed && !entry.replied)
      .slice(-max)
      .map((entry) => ({
        id: entry.id,
        ts: entry.ts,
        from: entry.from,
        message: entry.message,
        whisper: entry.whisper,
      }));
  }

  wasBotMessageRecentlySent(message: string, windowMs: number): boolean {
    const normalized = normalizeText(message);
    if (!normalized) {
      return false;
    }

    const cutoff = Date.now() - Math.max(1_000, windowMs);
    for (let i = this.conversationHistory.length - 1; i >= 0; i -= 1) {
      const turn = this.conversationHistory[i];
      if (turn.ts < cutoff) {
        break;
      }
      if (turn.speaker !== "bot") {
        continue;
      }
      if (normalizeText(turn.message) === normalized) {
        return true;
      }
    }
    return false;
  }

  enqueueReactiveAlerts(alerts: Array<{ topic: string; detail: string }>): void {
    for (const alert of alerts) {
      boundedPush(
        this.reactiveAlerts,
        {
          ts: Date.now(),
          topic: alert.topic,
          detail: alert.detail,
        },
        30,
      );
    }
  }

  consumeReactiveAlerts(max = 6): AlertEntry[] {
    const take = this.reactiveAlerts.slice(0, max);
    this.reactiveAlerts.splice(0, take.length);
    return take;
  }

  getReactiveContext() {
    const snapshot = this.lastSnapshot;
    return {
      self: snapshot?.self ?? null,
      inventory: snapshot?.inventory ?? null,
      nearbyHostiles: snapshot?.entities.hostiles.slice(0, 8) ?? [],
      planStatus: snapshot?.planStatus ?? null,
      recentSalientEvents: this.salientEvents.slice(-24).map((event) => ({
        ts: event.ts,
        type: event.type,
        salience: event.salience,
        data: event.data,
      })),
    };
  }

  getThinkingContext(persona: string, relationships: string, metadata: BotMetadata | null) {
    const directedChats = this.chatLog.filter((entry) => entry.directed).slice(-8);

    return {
      persona,
      relationships,
      metadata,
      selfState: this.lastSnapshot?.self ?? null,
      inventorySummary: this.lastSnapshot?.inventory ?? null,
      nearbyEntities: this.lastSnapshot?.entities ?? null,
      environment: this.lastSnapshot?.environment ?? null,
      planStatus: this.lastSnapshot?.planStatus ?? null,
      recentChat: this.chatLog.slice(-20),
      directedChats,
      rollingSummary: this.rollingSummary.slice(-40),
      recentFailures: this.recentFailures.slice(-12),
      pendingReactiveAlerts: this.consumeReactiveAlerts(8),
    };
  }

  getAgentContext(persona: string, relationships: string, metadata: BotMetadata | null, toolMetadata: unknown[], goals: Goal[] = []) {
    const materialEvents = this.salientEvents.filter((event) => isMaterialEvent(event)).slice(-15);

    return {
      persona,
      relationships,
      metadata,
      goals,
      self: this.lastSnapshot?.self ?? null,
      inventory: this.lastSnapshot?.inventory ?? null,
      entities: this.lastSnapshot?.entities ?? null,
      environment: this.lastSnapshot?.environment ?? null,
      planStatus: this.lastSnapshot?.planStatus ?? null,
      queueStatus: this.lastQueueSnapshot,
      recentChat: this.chatLog.slice(-12),
      pendingDirectedChats: this.getPendingDirectedChats(6),
      conversationHistory: this.conversationHistory.slice(-20),
      recentSalientEvents: materialEvents.map((event) => ({
        ts: event.ts,
        type: event.type,
        salience: event.salience,
        data: compactEventData(event),
      })),
      completedActions: this.completedActions.slice(-15),
      lastCompletedPlan: this.lastCompletedPlan,
      recentFailures: this.recentFailures.slice(-5),
      availableTools: toolMetadata,
    };
  }

  hasNewMaterialSince(tsExclusive: number): boolean {
    if (this.chatLog.some((entry) => entry.ts > tsExclusive)) {
      return true;
    }

    if (this.salientEvents.some((event) => event.ts > tsExclusive && isMaterialEvent(event))) {
      return true;
    }

    if (this.recentFailures.some((entry) => entry.ts > tsExclusive)) {
      return true;
    }

    return false;
  }

  getChatsSince(tsExclusive: number): ChatEntry[] {
    return this.chatLog.filter((entry) => entry.ts > tsExclusive);
  }

  getDirectedChatsSince(tsExclusive: number): ChatEntry[] {
    return this.chatLog.filter((entry) => entry.directed && entry.ts > tsExclusive);
  }

  getRecentFailuresSince(tsExclusive: number): Array<{ ts: number; detail: string }> {
    return this.recentFailures.filter((entry) => entry.ts > tsExclusive);
  }

  hasHighUrgencyTrigger(): boolean {
    const latest = this.salientEvents.at(-1);
    if (!latest) {
      return false;
    }
    if (latest.salience >= 0.85) {
      return true;
    }
    if (latest.type === "executor" && String(latest.data.event ?? "").includes("repeated_failure")) {
      return true;
    }
    return false;
  }

  latestDirectedChat(): ChatEntry | null {
    const directed = this.chatLog.filter((entry) => entry.directed);
    return directed.length > 0 ? directed[directed.length - 1] : null;
  }

  isIdle(): boolean {
    const status = this.lastSnapshot?.planStatus;
    if (!status) {
      return true;
    }
    return status.executorState === "idle" || status.currentAction === null;
  }

  getPlanStatus() {
    return this.lastSnapshot?.planStatus ?? null;
  }

  getQueueStatus() {
    return this.lastQueueSnapshot;
  }
}
