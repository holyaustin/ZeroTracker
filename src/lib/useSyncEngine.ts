"use client";
import { useEffect, useRef, useState } from "react";
import { createSyncEngine, type Engine, type SyncState } from "./syncEngine";

/** Owns the offline-first sender for the lifetime of the driver page (independent of whether a trip is running). */
export function useSyncEngine(token: string, onRevoked: (code: string) => void) {
  const engine = useRef<Engine | null>(null);
  const [state, setState] = useState<SyncState>({ queued: 0, connection: "online", lastSentAt: null });
  const revokedRef = useRef(onRevoked);
  revokedRef.current = onRevoked;

  useEffect(() => {
    const e = createSyncEngine({ token, onRevoked: (c) => revokedRef.current(c), onState: (s) => setState((p) => ({ ...p, ...s })) });
    engine.current = e;
    return () => { e.destroy(); engine.current = null; };
  }, [token]);

  return { engine, ...state };
}
