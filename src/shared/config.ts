import { z } from "zod";

const RuntimeConfigSchema = z.object({
  botName: z.string().min(1),
  mcHost: z.string().min(1),
  mcPort: z.number().int().positive(),
  mcUsername: z.string().min(1),
  mcAuth: z.enum(["offline", "microsoft", "mojang"]),
  mcVersion: z.string().optional(),
  wsHost: z.string().min(1),
  wsPort: z.number().int().positive(),
  snapshotIntervalMs: z.number().int().min(250).max(10_000),
  salienceMin: z.number().min(0).max(1),
  entityMoveMinIntervalMs: z.number().int().min(50).max(10_000),
  inventoryCoalesceMs: z.number().int().min(100).max(10_000),
  dangerRadius: z.number().min(1).max(64),
  actionTimeoutMs: z.number().int().min(500).max(300_000),
  idleBehavior: z.enum(["wander", "guard_home", "standby"]),
  repeatedFailureWindowMs: z.number().int().min(1_000).max(600_000),
  repeatedFailureThreshold: z.number().int().min(2).max(20),
  homePos: z
    .object({
      x: z.number(),
      y: z.number(),
      z: z.number(),
    })
    .optional(),
});

const BrainConfigSchema = z.object({
  botName: z.string().min(1),
  runtimeWsUrl: z.string().url(),
  reactiveCadenceMs: z.number().int().min(200).max(10_000),
  thinkingCadenceMs: z.number().int().min(800).max(30_000),
  thinkingMinGapMs: z.number().int().min(100).max(30_000),
  controlDedupWindowMs: z.number().int().min(300).max(10_000),
  replaceQueueMinGapMs: z.number().int().min(300).max(15_000),
  cancelMinGapMs: z.number().int().min(200).max(10_000),
  llmProvider: z.enum(["openai", "fireworks"]),
  openAiApiKey: z.string().optional(),
  openAiBaseUrl: z.string().url(),
  openAiModel: z.string().min(1),
  dangerRadius: z.number().min(1).max(64),
});

export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;
export type BrainConfig = z.infer<typeof BrainConfigSchema>;

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) {
    return fallback;
  }
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`Env var ${name} must be a number`);
  }
  return parsed;
}

function readString(name: string, fallback: string): string {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  return raw;
}

export function loadRuntimeConfig(): RuntimeConfig {
  const homeX = process.env.HOME_X;
  const homeY = process.env.HOME_Y;
  const homeZ = process.env.HOME_Z;

  const homePos =
    homeX !== undefined && homeY !== undefined && homeZ !== undefined
      ? { x: Number(homeX), y: Number(homeY), z: Number(homeZ) }
      : undefined;

  return RuntimeConfigSchema.parse({
    botName: readString("BOT_NAME", "Scout"),
    mcHost: readString("MC_HOST", "127.0.0.1"),
    mcPort: readNumber("MC_PORT", 25565),
    mcUsername: readString("MC_USERNAME", readString("BOT_NAME", "Scout")),
    mcAuth: readString("MC_AUTH", "offline"),
    mcVersion: process.env.MC_VERSION || undefined,
    wsHost: readString("RUNTIME_WS_HOST", "0.0.0.0"),
    wsPort: readNumber("RUNTIME_WS_PORT", 8787),
    snapshotIntervalMs: readNumber("SNAPSHOT_INTERVAL_MS", 1000),
    salienceMin: readNumber("SALIENCE_MIN", 0.15),
    entityMoveMinIntervalMs: readNumber("ENTITY_MOVE_MIN_INTERVAL_MS", 400),
    inventoryCoalesceMs: readNumber("INVENTORY_COALESCE_MS", 350),
    dangerRadius: readNumber("DANGER_RADIUS", 8),
    actionTimeoutMs: readNumber("ACTION_TIMEOUT_MS", 15_000),
    idleBehavior: readString("IDLE_BEHAVIOR", "standby"),
    repeatedFailureWindowMs: readNumber("REPEATED_FAILURE_WINDOW_MS", 60_000),
    repeatedFailureThreshold: readNumber("REPEATED_FAILURE_THRESHOLD", 3),
    homePos,
  });
}

export function loadBrainConfig(): BrainConfig {
  return BrainConfigSchema.parse({
    botName: readString("BOT_NAME", "Scout"),
    runtimeWsUrl: readString("BRAIN_RUNTIME_WS_URL", "ws://127.0.0.1:8787"),
    reactiveCadenceMs: readNumber("REACTIVE_CADENCE_MS", 1200),
    thinkingCadenceMs: readNumber("THINKING_CADENCE_MS", 2000),
    thinkingMinGapMs: readNumber("THINKING_MIN_GAP_MS", 600),
    controlDedupWindowMs: readNumber("CONTROL_DEDUP_WINDOW_MS", 1000),
    replaceQueueMinGapMs: readNumber("REPLACE_QUEUE_MIN_GAP_MS", 1500),
    cancelMinGapMs: readNumber("CANCEL_MIN_GAP_MS", 800),
    llmProvider: readString("LLM_PROVIDER", "openai"),
    openAiApiKey: process.env.OPENAI_API_KEY || undefined,
    openAiBaseUrl: readString("OPENAI_BASE_URL", "https://api.openai.com/v1"),
    openAiModel: readString("OPENAI_MODEL", "gpt-4.1-mini"),
    dangerRadius: readNumber("DANGER_RADIUS", 8),
  });
}
