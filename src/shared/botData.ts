import { readFileSync } from "node:fs";
import path from "node:path";

export interface BotMetadata {
  home?: { x: number; y: number; z: number };
  preferences?: Record<string, unknown>;
}

export function readBotMetadata(botName: string): BotMetadata | null {
  const file = path.resolve("mcbots", botName, "metadata.json");
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as BotMetadata;
    return parsed;
  } catch {
    return null;
  }
}
