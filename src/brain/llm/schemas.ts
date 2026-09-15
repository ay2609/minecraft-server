import { z } from "zod";
import { ActionSchema } from "../../shared/protocol.js";

export const AgentControlSchema = z.discriminatedUnion("cmd", [
  z.object({
    cmd: z.literal("replaceQueue"),
    actions: z.array(ActionSchema).min(1).max(32),
    planId: z.string().min(1).max(120).optional(),
    reason: z.string().max(256).optional(),
  }),
  z.object({
    cmd: z.literal("prependActions"),
    actions: z.array(ActionSchema).min(1).max(16),
    priority: z.enum(["urgent", "normal"]).default("normal"),
    reason: z.string().max(256).optional(),
  }),
  z.object({
    cmd: z.literal("cancelCurrent"),
    reason: z.string().max(256).optional(),
  }),
  z.object({
    cmd: z.literal("setIdleBehavior"),
    behavior: z.enum(["wander", "guard_home", "standby"]),
  }),
]);

export const GoalUpdateSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("add"),
    description: z.string().max(200),
    priority: z.number().int().min(1).max(10).default(5),
    source: z.enum(["agent", "player_request", "discovery"]).default("agent"),
    notes: z.string().max(200).optional(),
  }),
  z.object({
    op: z.literal("complete"),
    id: z.string().max(64),
    notes: z.string().max(200).optional(),
  }),
  z.object({
    op: z.literal("fail"),
    id: z.string().max(64),
    notes: z.string().max(200).optional(),
  }),
  z.object({
    op: z.literal("update"),
    id: z.string().max(64),
    description: z.string().max(200).optional(),
    priority: z.number().int().min(1).max(10).optional(),
    notes: z.string().max(200).optional(),
  }),
]);

export const AgentOutputSchema = z.object({
  thoughts: z.string().max(600).optional(),
  say: z.array(z.string().min(1).max(180)).max(4).optional(),
  control: AgentControlSchema.optional(),
  memoryUpdate: z
    .object({
      mode: z.enum(["append", "replace"]),
      content: z.string().min(1).max(16_000),
    })
    .optional(),
  goalUpdates: z.array(GoalUpdateSchema).max(5).optional(),
});

export type AgentOutput = z.infer<typeof AgentOutputSchema>;
export type AgentControl = z.infer<typeof AgentControlSchema>;
export type GoalUpdate = z.infer<typeof GoalUpdateSchema>;
