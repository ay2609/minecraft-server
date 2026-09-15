import { z } from "zod";

export const PROTOCOL_VERSION = 1;

export const Vec3Schema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
});

export const ActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("say"), message: z.string().min(1).max(256) }),
  z.object({ type: z.literal("wait"), ms: z.number().int().min(0).max(120_000) }),
  z.object({
    type: z.literal("goto"),
    x: z.number(),
    y: z.number(),
    z: z.number(),
    radius: z.number().min(0).max(16).optional(),
  }),
  z.object({
    type: z.literal("follow"),
    targetType: z.enum(["player", "bot"]),
    name: z.string().min(1),
    distance: z.number().min(1).max(16).optional(),
  }),
  z.object({
    type: z.literal("flee"),
    from: Vec3Schema,
    radius: z.number().min(2).max(64),
  }),
  z.object({
    type: z.literal("run_tool"),
    name: z.string().min(1),
    args: z.record(z.unknown()).default({}),
  }),
  z.object({
    type: z.literal("idle"),
    behavior: z.enum(["wander", "guard_home", "standby"]),
  }),
]);

export type BotAction = z.infer<typeof ActionSchema>;

export const EventTypeSchema = z.enum([
  "chat",
  "whisper",
  "playerSeen",
  "playerGone",
  "entitySeen",
  "entityGone",
  "entityMove",
  "hurt",
  "health",
  "death",
  "inventory",
  "blockHazard",
  "pathfinder",
  "tool",
  "executor",
]);

export type EventType = z.infer<typeof EventTypeSchema>;

const BaseEnvelopeSchema = z.object({
  v: z.number().int().default(PROTOCOL_VERSION),
  bot: z.string().min(1),
  ts: z.number().int(),
  id: z.string().optional(),
});

export const EventMessageSchema = BaseEnvelopeSchema.extend({
  kind: z.literal("event"),
  type: EventTypeSchema,
  salience: z.number().min(0).max(1),
  data: z.record(z.unknown()),
});

export const SnapshotDataSchema = z.object({
  self: z.object({
    pos: Vec3Schema,
    yaw: z.number(),
    pitch: z.number(),
    health: z.number(),
    food: z.number(),
    biome: z.string().optional(),
    dimension: z.string().optional(),
    timeOfDay: z.number().optional(),
  }),
  inventory: z.object({
    items: z
      .array(
        z.object({
          name: z.string(),
          count: z.number().int(),
        }),
      )
      .max(64),
    equipped: z
      .object({
        hand: z.string().optional(),
        head: z.string().optional(),
        torso: z.string().optional(),
        legs: z.string().optional(),
        feet: z.string().optional(),
      })
      .optional(),
  }),
  entities: z.object({
    players: z
      .array(
        z.object({
          name: z.string(),
          dist: z.number(),
          pos: Vec3Schema,
        }),
      )
      .max(20),
    hostiles: z
      .array(
        z.object({
          type: z.string(),
          dist: z.number(),
          pos: Vec3Schema,
        }),
      )
      .max(20),
  }),
  environment: z.object({
    hazards: z.array(z.string()).max(16),
    notableBlocks: z.array(z.string()).max(32),
    nearbyResources: z.record(z.number().int()).optional(),
  }),
  planStatus: z.object({
    planId: z.string().nullable(),
    stepIndex: z.number().int().min(0),
    currentAction: z.string().nullable(),
    executorState: z.enum(["idle", "running", "blocked", "canceling", "error"]),
  }),
});

export const SnapshotMessageSchema = BaseEnvelopeSchema.extend({
  kind: z.literal("snapshot"),
  seq: z.number().int().min(0),
  data: SnapshotDataSchema,
});

export const ReplaceQueueDataSchema = z.object({
  actions: z.array(ActionSchema).max(32),
  planId: z.string().min(1).optional(),
  reason: z.string().max(256).optional(),
});

export const PrependActionsDataSchema = z.object({
  actions: z.array(ActionSchema).max(16),
  priority: z.enum(["urgent", "normal"]).default("normal"),
  reason: z.string().max(256).optional(),
});

export const CancelCurrentDataSchema = z.object({
  reason: z.string().max(256).optional(),
});

export const SetIdleBehaviorDataSchema = z.object({
  behavior: z.enum(["wander", "guard_home", "standby"]),
});

export const RequestSnapshotDataSchema = z.object({});

export const ControlMessageSchema = BaseEnvelopeSchema.extend({
  kind: z.literal("control"),
  cmd: z.enum([
    "replaceQueue",
    "prependActions",
    "cancelCurrent",
    "setIdleBehavior",
    "requestSnapshot",
  ]),
  data: z.unknown().optional(),
}).superRefine((value, ctx) => {
  const schemaByCommand: Record<string, z.ZodSchema> = {
    replaceQueue: ReplaceQueueDataSchema,
    prependActions: PrependActionsDataSchema,
    cancelCurrent: CancelCurrentDataSchema,
    setIdleBehavior: SetIdleBehaviorDataSchema,
    requestSnapshot: RequestSnapshotDataSchema,
  };

  const schema = schemaByCommand[value.cmd];
  const parsed = schema.safeParse(value.data ?? {});
  if (!parsed.success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Invalid data for cmd=${value.cmd}: ${parsed.error.message}`,
      path: ["data"],
    });
  }
});

export const AckMessageSchema = BaseEnvelopeSchema.extend({
  kind: z.literal("ack"),
  ok: z.boolean(),
  refId: z.string().optional(),
  data: z.record(z.unknown()).optional(),
  error: z.string().optional(),
});

export const AnyInboundRuntimeMessageSchema = ControlMessageSchema;

export const RuntimeOutboundMessageSchema = z.discriminatedUnion("kind", [
  EventMessageSchema,
  SnapshotMessageSchema,
  AckMessageSchema,
]);

export type EventMessage = z.infer<typeof EventMessageSchema>;
export type SnapshotMessage = z.infer<typeof SnapshotMessageSchema>;
export type SnapshotData = z.infer<typeof SnapshotDataSchema>;
export type ControlMessage = z.infer<typeof ControlMessageSchema>;
export type AckMessage = z.infer<typeof AckMessageSchema>;
export type RuntimeOutboundMessage = z.infer<typeof RuntimeOutboundMessageSchema>;

export function createEnvelopeBase(bot: string, id?: string) {
  return {
    v: PROTOCOL_VERSION,
    bot,
    ts: Date.now(),
    ...(id ? { id } : {}),
  };
}

export function parseIncomingJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON payload: ${(error as Error).message}`);
  }
}

export function parseControlMessage(raw: string): ControlMessage {
  const payload = parseIncomingJson(raw);
  return ControlMessageSchema.parse(payload);
}
