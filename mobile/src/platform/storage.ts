import * as SecureStore from "expo-secure-store";

export type Binding = { baseUrl: string; token: string; vehicleLabel: string; orgName: string };
const K = { binding: "zt.binding", consent: "zt.consent", trip: "zt.trip" };

const get = async (k: string) => { try { return await SecureStore.getItemAsync(k); } catch { return null; } };
const set = (k: string, v: string) => SecureStore.setItemAsync(k, v).catch(() => {});
const del = (k: string) => SecureStore.deleteItemAsync(k).catch(() => {});

export const storage = {
  binding: async (): Promise<Binding | null> => { try { return JSON.parse((await get(K.binding)) ?? "null"); } catch { return null; } },
  setBinding: (b: Binding) => set(K.binding, JSON.stringify(b)),
  consent: async () => (await get(K.consent)) !== null,
  setConsent: () => set(K.consent, String(Date.now())),
  tripStartedAt: async () => { const n = Number(await get(K.trip)); return n > 0 ? n : null; },
  setTrip: (at: number) => set(K.trip, String(at)),
  clearTrip: () => del(K.trip),
  forgetAll: async () => { await del(K.binding); await del(K.trip); },
};
