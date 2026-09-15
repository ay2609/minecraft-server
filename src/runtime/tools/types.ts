import { z } from "zod";
import type { Bot } from "mineflayer";
import type { MovementController } from "../movement/controller.js";

export interface ToolContext {
  bot: Bot;
  movement: MovementController;
  signal: AbortSignal;
  emit: (event: string, data: Record<string, unknown>) => void;
  timeoutMs: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  argsHint: Record<string, string>;
  argsSchema: z.ZodSchema;
  preconditions?: string[];
  run: (args: Record<string, unknown>, context: ToolContext) => Promise<Record<string, unknown>>;
}
