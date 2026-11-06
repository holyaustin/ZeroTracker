import type { RawFix } from "../core/tripController";

export const LOCATION_TASK = "zerotracker-location";
let handler: ((f: RawFix) => void) | null = null;
/** The background task and the trip controller meet here (the task has no access to React state). */
export const setFixHandler = (h: ((f: RawFix) => void) | null) => { handler = h; };
export const hasFixHandler = () => handler !== null;
export const deliverFixes = (fixes: RawFix[]) => fixes.forEach((f) => handler?.(f));
