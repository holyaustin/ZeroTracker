import * as Ably from "ably";
import { appendFileSync } from "fs";

/**
 * Realtime layer. Everything goes through publish() / subscribeToken(), so Ably can later be
 * swapped for Pusher or a Socket.io server by changing only this file.
 * REALTIME_DRIVER=console appends events to REALTIME_OUTBOX_PATH instead of calling Ably (dev/tests).
 */
let rest: Ably.Rest | undefined;
const client = () => (rest ??= new Ably.Rest({ key: process.env.ABLY_API_KEY! }));

export { channels } from "./channels";
import { channels } from "./channels";

/** The database is the source of truth, so a failed publish is logged and never fails the request. */
export async function publish(channel: string, event: string, data: unknown) {
  try {
    if (process.env.REALTIME_DRIVER === "console") {
      appendFileSync(process.env.REALTIME_OUTBOX_PATH ?? ".realtime.jsonl", JSON.stringify({ channel, event, data }) + "\n");
      return;
    }
    await client().channels.get(channel).publish(event, data);
  } catch (e) {
    console.error("[realtime] publish failed:", channel, event, (e as Error).message);
  }
}

/** Subscribe-only token. Clients can never publish. */
export const subscribeToken = (clientId: string, channelPatterns: string[], ttlMs?: number) =>
  client().auth.createTokenRequest({
    clientId,
    ...(ttlMs ? { ttl: ttlMs } : {}),
    capability: Object.fromEntries(channelPatterns.map((c) => [c, ["subscribe"]])),
  });
