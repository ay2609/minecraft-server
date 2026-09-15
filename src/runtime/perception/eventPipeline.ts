import type { EventType, EventMessage } from "../../shared/protocol.js";
import { createEnvelopeBase } from "../../shared/protocol.js";
import type { RuntimeConfig } from "../../shared/config.js";
import { scoreSalience } from "./salience.js";

interface EventSink {
  broadcast: (message: Record<string, unknown>) => void;
}

/** Salience threshold above which entityMove bypasses rate limiting (e.g. hostile in danger radius). */
const ENTITY_MOVE_URGENT_SALIENCE = 0.85;

export class EventPipeline {
  private readonly lastSentAtByType = new Map<string, number>();
  private inventoryTimer: NodeJS.Timeout | null = null;
  private pendingInventoryData: Record<string, unknown> | null = null;

  constructor(
    private readonly botName: string,
    private readonly config: RuntimeConfig,
    private readonly sink: EventSink,
  ) {}

  emit(type: EventType, data: Record<string, unknown>, explicitSalience?: number): void {
    const salience = explicitSalience ?? scoreSalience(type, data, this.config.dangerRadius);
    if (salience < this.config.salienceMin) {
      return;
    }

    const now = Date.now();
    if (!this.canSend(type, now, salience, data)) {
      return;
    }

    const event: EventMessage = {
      ...createEnvelopeBase(this.botName),
      kind: "event",
      type,
      salience,
      data,
    };

    this.sink.broadcast(event);
  }

  queueInventoryEvent(data: Record<string, unknown>): void {
    this.pendingInventoryData = data;
    if (this.inventoryTimer) {
      return;
    }

    this.inventoryTimer = setTimeout(() => {
      const payload = this.pendingInventoryData;
      this.pendingInventoryData = null;
      this.inventoryTimer = null;
      if (payload) {
        this.emit("inventory", payload);
      }
    }, this.config.inventoryCoalesceMs);
  }

  private canSend(
    type: EventType,
    now: number,
    salience?: number,
    _data?: Record<string, unknown>,
  ): boolean {
    let minInterval = 0;
    if (type === "entityMove") {
      minInterval = this.config.entityMoveMinIntervalMs;
      // Urgent entity moves (e.g. hostile within danger radius) bypass rate limit
      if (typeof salience === "number" && salience >= ENTITY_MOVE_URGENT_SALIENCE) {
        this.lastSentAtByType.set(type, now);
        return true;
      }
    }
    if (type === "inventory") {
      minInterval = this.config.inventoryCoalesceMs;
    }

    if (minInterval <= 0) {
      return true;
    }

    const last = this.lastSentAtByType.get(type) ?? 0;
    if (now - last < minInterval) {
      return false;
    }

    this.lastSentAtByType.set(type, now);
    return true;
  }

  flush(): void {
    if (!this.inventoryTimer) {
      return;
    }
    clearTimeout(this.inventoryTimer);
    this.inventoryTimer = null;
    if (this.pendingInventoryData) {
      this.emit("inventory", this.pendingInventoryData);
      this.pendingInventoryData = null;
    }
  }
}
