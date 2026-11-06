import { TripController } from "../core/tripController";
import type { DriverLink } from "../core/link";
import { createNetwork, expoPlatform } from "./expoPlatform";
import { openQueue } from "./sqlite";
import { storage, type Binding } from "./storage";

let controller: TripController | null = null;
let building: Promise<TripController | null> | null = null;

async function build(b: Binding): Promise<TripController> {
  const net = createNetwork();
  return new TripController({ token: b.token, baseUrl: b.baseUrl, store: await openQueue(), platform: expoPlatform, isOnline: net.isOnline, target: net.target });
}

/** One controller per app process. The background task calls this too, so a trip survives the app being relaunched by the OS. */
export function getController(): Promise<TripController | null> {
  if (controller) return Promise.resolve(controller);
  building ??= (async () => {
    const b = await storage.binding();
    if (!b) return null;
    controller = await build(b);
    return controller;
  })().finally(() => { building = null; });
  return building;
}

/** Validates a pasted/tapped link with the server and, if good, remembers it. */
export async function connect(link: DriverLink): Promise<{ ok: true; binding: Binding } | { ok: false; code: string }> {
  controller?.destroy(); controller = null;
  const probe = new TripController({ token: link.token, baseUrl: link.baseUrl, store: await openQueue(), platform: expoPlatform });
  const r = await probe.session();
  probe.destroy();
  if (!r.ok) return { ok: false, code: r.code };
  const binding: Binding = { baseUrl: link.baseUrl, token: link.token, vehicleLabel: r.vehicleLabel, orgName: r.orgName };
  await storage.setBinding(binding);
  return { ok: true, binding };
}

export async function startTrip() {
  const c = await getController(); if (!c) return;
  await storage.setTrip(Date.now());
  await c.start();
}
export async function endTrip() { await storage.clearTrip(); await (await getController())?.stop(); }
export async function forget() { await endTrip(); controller?.destroy(); controller = null; await storage.forgetAll(); }

/** Called on launch and from the background task: if a trip was running, bring sensors and uploading back. */
export async function resumeIfTripActive() {
  if (!(await storage.tripStartedAt())) return null;
  const c = await getController();
  if (c && c.getState().phase === "idle") await c.start();
  return c;
}
