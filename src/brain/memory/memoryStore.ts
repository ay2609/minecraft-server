import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { readBotMetadata, type BotMetadata } from "../../shared/botData.js";

const RELATIONSHIP_MAX_BYTES = 16_000;
const RELATIONSHIPS_DEFAULT = "# Relationships\n\n- No notable interactions yet.\n";
const PERSONA_DEFAULT = "# Persona\n\nYou are a practical Minecraft companion bot.\n";
// SOUL.md is user-curated and never changed by the bot; cache aggressively.
const PERSONA_CACHE_TTL_MS = 60_000;

export interface MemoryUpdate {
  mode: "append" | "replace";
  content: string;
}

export class MemoryStore {
  private readonly baseDir: string;
  private readonly soulPath: string;
  private readonly relationshipsPath: string;
  private readonly botName: string;

  // Persona (SOUL.md) never changes during a session — cache with long TTL.
  private cachedPersona: string | null = null;
  private personaCachedAt = 0;

  // Relationships: cache the current content; invalidate when we write a new version.
  // This eliminates the disk read on every LLM cycle (was 1 read/1-5s).
  private cachedRelationships: string | null = null;

  constructor(botName: string) {
    this.botName = botName;
    this.baseDir = path.resolve("mcbots", botName);
    this.soulPath = path.resolve(this.baseDir, "SOUL.md");
    this.relationshipsPath = path.resolve(this.baseDir, "relationships.md");
  }

  async ensureFiles(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });

    // SOUL.md: create only if it doesn't already exist (user-curated)
    try {
      await readFile(this.soulPath, "utf8");
    } catch {
      await writeFile(this.soulPath, PERSONA_DEFAULT, "utf8");
    }

    // relationships.md: always reset to default so no stale context leaks
    // across sessions. The bot rebuilds relationship knowledge each run.
    await writeFile(this.relationshipsPath, RELATIONSHIPS_DEFAULT, "utf8");
    this.cachedRelationships = RELATIONSHIPS_DEFAULT; // prime cache to avoid first-read disk I/O
  }

  async readPersona(): Promise<string> {
    const now = Date.now();
    if (this.cachedPersona !== null && now - this.personaCachedAt < PERSONA_CACHE_TTL_MS) {
      return this.cachedPersona;
    }
    this.cachedPersona = await readFile(this.soulPath, "utf8");
    this.personaCachedAt = now;
    return this.cachedPersona;
  }

  async readRelationships(): Promise<string> {
    if (this.cachedRelationships !== null) {
      return this.cachedRelationships;
    }
    this.cachedRelationships = await readFile(this.relationshipsPath, "utf8");
    return this.cachedRelationships;
  }

  readMetadata(): BotMetadata | null {
    return readBotMetadata(this.botName);
  }

  async applyRelationshipUpdate(update: MemoryUpdate): Promise<void> {
    const current = await this.readRelationships();

    let next = current;
    if (update.mode === "replace") {
      next = update.content;
    } else {
      next = `${current.trim()}\n\n${update.content.trim()}\n`;
    }

    if (Buffer.byteLength(next, "utf8") > RELATIONSHIP_MAX_BYTES) {
      next = this.boundAndSummarize(next);
    }

    const tempPath = `${this.relationshipsPath}.tmp`;
    await writeFile(tempPath, next, "utf8");
    await rename(tempPath, this.relationshipsPath);
    // Keep cache consistent so the next readRelationships() doesn't re-read from disk.
    this.cachedRelationships = next;
  }

  private boundAndSummarize(content: string): string {
    const lines = content.split("\n").filter((line) => line.trim().length > 0);
    const keep = lines.slice(Math.max(0, lines.length - 80));
    return [
      "# Relationships",
      "",
      "- Older notes were summarized to keep memory bounded.",
      ...keep,
      "",
    ].join("\n");
  }
}
