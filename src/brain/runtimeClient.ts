import { WebSocket } from "ws";
import {
  AckMessageSchema,
  ControlMessageSchema,
  type ControlMessage,
  type EventMessage,
  EventMessageSchema,
  type SnapshotMessage,
  SnapshotMessageSchema,
  createEnvelopeBase,
} from "../shared/protocol.js";
import { makeId } from "../shared/utils.js";

interface RuntimeClientHandlers {
  onEvent: (event: EventMessage) => void;
  onSnapshot: (snapshot: SnapshotMessage) => void;
}

export class RuntimeClient {
  private eventsWs: WebSocket | null = null;
  private controlWs: WebSocket | null = null;
  private controlConnected = false;
  private readonly pendingAcks = new Map<string, { resolve: () => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }>();
  private lastHealth = 20;
  private lastFood = 20;

  constructor(
    private readonly botName: string,
    private readonly baseWsUrl: string,
    private readonly handlers: RuntimeClientHandlers,
  ) {}

  start(): void {
    this.connectEvents();
    this.connectControl();
  }

  async sendControl(cmd: ControlMessage["cmd"], data: Record<string, unknown>): Promise<boolean> {
    if (!this.controlWs || this.controlWs.readyState !== WebSocket.OPEN || !this.controlConnected) {
      return false;
    }

    const id = makeId("ctl");
    const payload = {
      ...createEnvelopeBase(this.botName, id),
      kind: "control",
      cmd,
      data,
    };

    const parsed = ControlMessageSchema.safeParse(payload);
    if (!parsed.success) {
      return false;
    }

    const ackPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingAcks.delete(id);
        reject(new Error(`ack_timeout:${cmd}`));
      }, 4_000);

      this.pendingAcks.set(id, { resolve, reject, timeout });
    });

    this.controlWs.send(JSON.stringify(payload));

    try {
      await ackPromise;
      return true;
    } catch {
      return false;
    }
  }

  private connectEvents(): void {
    const url = new URL("/events", this.baseWsUrl).toString();
    const ws = new WebSocket(url);
    this.eventsWs = ws;

    ws.on("message", (data) => {
      const raw = data.toString("utf8");
      try {
        const parsed = JSON.parse(raw);
        if (parsed.kind === "event") {
          const event = EventMessageSchema.parse(parsed);
          this.handlers.onEvent(event);
          return;
        }

        if (parsed.kind === "snapshot") {
          const normalized = this.normalizeSnapshot(parsed);
          const snapshotParsed = SnapshotMessageSchema.safeParse(normalized);
          if (!snapshotParsed.success) {
            return;
          }

          this.lastHealth = snapshotParsed.data.data.self.health;
          this.lastFood = snapshotParsed.data.data.self.food;
          this.handlers.onSnapshot(snapshotParsed.data);
        }
      } catch {
      }
    });

    ws.on("close", () => {
      setTimeout(() => this.connectEvents(), 1_000);
    });

    ws.on("error", () => {});
  }

  private connectControl(): void {
    const url = new URL("/control", this.baseWsUrl).toString();
    const ws = new WebSocket(url);
    this.controlWs = ws;

    ws.on("open", () => {
      this.controlConnected = true;
    });

    ws.on("message", (data) => {
      const raw = data.toString("utf8");
      try {
        const parsed = AckMessageSchema.parse(JSON.parse(raw));
        if (!parsed.refId) {
          return;
        }

        const pending = this.pendingAcks.get(parsed.refId);
        if (!pending) {
          return;
        }

        clearTimeout(pending.timeout);
        this.pendingAcks.delete(parsed.refId);
        if (parsed.ok) {
          pending.resolve();
        } else {
          pending.reject(new Error(parsed.error ?? "ack_error"));
        }
      } catch {
      }
    });

    ws.on("close", () => {
      this.controlConnected = false;
      for (const [id, pending] of this.pendingAcks.entries()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("control_disconnected"));
        this.pendingAcks.delete(id);
      }
      setTimeout(() => this.connectControl(), 1_000);
    });

    ws.on("error", () => {});
  }

  private normalizeSnapshot(raw: unknown): unknown {
    if (!raw || typeof raw !== "object") {
      return raw;
    }

    const value = raw as Record<string, unknown>;
    const data = value.data;
    if (!data || typeof data !== "object") {
      return raw;
    }

    const dataObj = data as Record<string, unknown>;
    const self = dataObj.self;
    if (!self || typeof self !== "object") {
      return raw;
    }

    const selfObj = self as Record<string, unknown>;
    const health =
      typeof selfObj.health === "number"
        ? selfObj.health
        : (typeof selfObj.hp === "number" ? selfObj.hp : this.lastHealth);
    const food = typeof selfObj.food === "number" ? selfObj.food : this.lastFood;

    return {
      ...value,
      data: {
        ...dataObj,
        self: {
          ...selfObj,
          health,
          food,
        },
      },
    };
  }
}
