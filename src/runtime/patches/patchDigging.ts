import type { Bot } from "mineflayer";

/**
 * Minecraft 1.19+ requires a monotonically-increasing `sequence` varint in
 * every `block_dig` packet.  The server uses it to acknowledge player actions
 * and to decide whether to broadcast the breaking animation / actually break
 * the block.  mineflayer 4.x never populates this field, so the server
 * silently discards every dig the bot sends.
 *
 * This patch intercepts every outgoing `block_dig` write and injects the
 * next sequence number before the packet is serialized.
 */
export function patchDigging(bot: Bot): void {
  let sequence = 0;
  const client = bot._client as any;
  const origWrite: (...args: any[]) => void = client.write.bind(client);

  client.write = (name: string, data: any, ...rest: any[]) => {
    if (name === "block_dig") {
      data.sequence = sequence++;
    }
    return origWrite(name, data, ...rest);
  };
}
