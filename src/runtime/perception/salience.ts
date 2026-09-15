import type { EventType } from "../../shared/protocol.js";
import { clamp } from "../../shared/utils.js";

const HOSTILE_KINDS = new Set([
  "zombie",
  "husk",
  "drowned",
  "skeleton",
  "stray",
  "creeper",
  "spider",
  "cave_spider",
  "enderman",
  "witch",
  "pillager",
  "vindicator",
  "evoker",
  "phantom",
  "guardian",
  "elder_guardian",
  "blaze",
  "hoglin",
  "piglin_brute",
  "wither_skeleton",
  "ghast",
  "slime",
  "magma_cube",
]);

export function scoreSalience(type: EventType, data: Record<string, unknown>, dangerRadius: number): number {
  switch (type) {
    case "chat":
    case "whisper":
      return 0.95;
    case "hurt":
    case "death":
      return 1;
    case "health": {
      const delta = Math.abs(Number(data.delta ?? 0));
      return clamp(0.4 + delta / 20, 0, 1);
    }
    case "pathfinder":
      return 0.85;
    case "tool":
      return 0.7;
    case "executor": {
      const event = String(data.event ?? "");
      if (event.includes("failed") || event.includes("repeated_failure")) {
        return 0.95;
      }
      if (event.includes("canceled")) {
        return 0.8;
      }
      return 0.6;
    }
    case "blockHazard":
      return 0.9;
    case "entityMove": {
      const dist = Number(data.dist ?? 99);
      const kind = String(data.kind ?? "").toLowerCase();

      if (kind === "player") {
        if (dist <= 2) {
          return 0.35;
        }
        if (dist <= 6) {
          return 0.22;
        }
        return 0.08;
      }

      const hostile = HOSTILE_KINDS.has(kind);
      if (hostile && dist <= dangerRadius) {
        return 0.9;
      }
      if (hostile && dist <= dangerRadius * 2) {
        return 0.65;
      }

      if (dist <= dangerRadius) {
        return 0.3;
      }
      if (dist <= dangerRadius * 2) {
        return 0.18;
      }
      return 0.1;
    }
    case "entitySeen":
    case "playerSeen":
      return 0.6;
    case "inventory":
      return 0.55;
    default:
      return 0.3;
  }
}
