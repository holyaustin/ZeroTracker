import * as TaskManager from "expo-task-manager";
import type * as Location from "expo-location";
import { LOCATION_TASK, deliverFixes, hasFixHandler } from "../platform/locationBridge";
import { resumeIfTripActive } from "../platform/runtime";

/**
 * Runs whenever the OS has new GPS fixes, even with the screen off. If the app process was restarted just for this,
 * the trip controller is rebuilt from the saved state first.
 */
TaskManager.defineTask(LOCATION_TASK, async ({ data, error }) => {
  if (error) return;
  if (!hasFixHandler()) await resumeIfTripActive();
  const { locations } = (data ?? {}) as { locations?: Location.LocationObject[] };
  if (locations?.length) deliverFixes(locations.map((l) => l.coords));
});
