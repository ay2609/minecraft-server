import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import { AckMessageSchema, createEnvelopeBase } from "../../shared/protocol.js";

export type ControlHandler = (raw: string, ws: WebSocket) => Promise<void>;
export type EventsConnectHandler = (ws: WebSocket) => void | Promise<void>;

export class RuntimeWsServer {
  private readonly httpServer = createServer((_req, res) => {
    res.writeHead(404);
    res.end("Not found");
  });

  private readonly eventsWss = new WebSocketServer({ noServer: true });
  private readonly controlWss = new WebSocketServer({ noServer: true });
  private controlHandler: ControlHandler | null = null;
  private eventsConnectHandler: EventsConnectHandler | null = null;

  constructor(private readonly botName: string) {}

  setControlHandler(handler: ControlHandler): void {
    this.controlHandler = handler;
  }

  setEventsConnectHandler(handler: EventsConnectHandler): void {
    this.eventsConnectHandler = handler;
  }

  async start(host: string, port: number): Promise<void> {
    this.httpServer.on("upgrade", (request: IncomingMessage, socket: Socket, head) => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (url.pathname === "/events") {
        this.eventsWss.handleUpgrade(request, socket, head, (ws) => {
          this.eventsWss.emit("connection", ws, request);
        });
        return;
      }
      if (url.pathname === "/control") {
        this.controlWss.handleUpgrade(request, socket, head, (ws) => {
          this.controlWss.emit("connection", ws, request);
        });
        return;
      }
      socket.destroy();
    });

    this.eventsWss.on("connection", (ws) => {
      if (this.eventsConnectHandler) {
        void this.eventsConnectHandler(ws);
      }
    });

    this.controlWss.on("connection", (ws) => {
      ws.on("message", async (data) => {
        try {
          if (!this.controlHandler) {
            throw new Error("No control handler configured");
          }
          await this.controlHandler(data.toString("utf8"), ws);
        } catch (error) {
          const message = {
            ...createEnvelopeBase(this.botName),
            kind: "ack",
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          };
          if (AckMessageSchema.safeParse(message).success) {
            ws.send(JSON.stringify(message));
          }
        }
      });
    });

    await new Promise<void>((resolve) => {
      this.httpServer.listen(port, host, () => resolve());
    });
  }

  broadcast(message: Record<string, unknown>): void {
    const serialized = JSON.stringify(message);
    for (const client of this.eventsWss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(serialized);
      }
    }
  }

  sendAck(ws: WebSocket, ok: boolean, refId?: string, data?: Record<string, unknown>, error?: string): void {
    const payload = {
      ...createEnvelopeBase(this.botName),
      kind: "ack",
      ok,
      ...(refId ? { refId } : {}),
      ...(data ? { data } : {}),
      ...(error ? { error } : {}),
    };
    ws.send(JSON.stringify(payload));
  }
}
