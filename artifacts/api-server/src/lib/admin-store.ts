import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type AdminSettings = {
  maintenanceMode: boolean;
  maintenanceMessage: string;
  emptyRoomTimeoutSeconds: number;
};

export type MetricSnapshot = {
  at: string;
  rooms: number;
  participants: number;
  messages: number;
};

type AdminState = {
  settings: AdminSettings;
  metrics: MetricSnapshot[];
};

const statePath = path.resolve(
  process.env.ADMIN_STATE_PATH || path.join(process.cwd(), "data", "admin-state.json"),
);
const defaults: AdminState = {
  settings: {
    maintenanceMode: false,
    maintenanceMessage: "Sitemiz kısa bir bakım çalışması nedeniyle geçici olarak kullanılamıyor. Lütfen biraz sonra tekrar dene.",
    emptyRoomTimeoutSeconds: 120,
  },
  metrics: [],
};
let mutationQueue: Promise<void> = Promise.resolve();

async function readState(): Promise<AdminState> {
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8")) as Partial<AdminState>;
    const rawSettings: Partial<AdminSettings> = parsed.settings && typeof parsed.settings === "object" ? parsed.settings : {};
    const rawMetrics = Array.isArray(parsed.metrics) ? parsed.metrics : [];
    return {
      settings: {
        maintenanceMode: rawSettings.maintenanceMode === true,
        maintenanceMessage: typeof rawSettings.maintenanceMessage === "string"
          ? rawSettings.maintenanceMessage.slice(0, 500)
          : defaults.settings.maintenanceMessage,
        emptyRoomTimeoutSeconds: typeof rawSettings.emptyRoomTimeoutSeconds === "number" && Number.isFinite(rawSettings.emptyRoomTimeoutSeconds)
          ? Math.max(30, Math.min(900, Math.round(rawSettings.emptyRoomTimeoutSeconds)))
          : defaults.settings.emptyRoomTimeoutSeconds,
      },
      metrics: rawMetrics.filter((item): item is MetricSnapshot =>
        !!item && typeof item.at === "string" && Number.isFinite(item.rooms) &&
        Number.isFinite(item.participants) && Number.isFinite(item.messages),
      ).slice(-10080),
    };
  } catch {
    return structuredClone(defaults);
  }
}

async function mutateState(mutator: (state: AdminState) => void): Promise<AdminState> {
  let result: AdminState = structuredClone(defaults);
  const task = mutationQueue.then(async () => {
    const state = await readState();
    mutator(state);
    await mkdir(path.dirname(statePath), { recursive: true });
    const tempPath = `${statePath}.${process.pid}.tmp`;
    await writeFile(tempPath, JSON.stringify(state, null, 2), "utf8");
    await rename(tempPath, statePath);
    result = state;
  });
  mutationQueue = task.catch(() => undefined);
  await task;
  return result;
}

export async function getAdminSettings(): Promise<AdminSettings> {
  return (await readState()).settings;
}

export async function updateAdminSettings(patch: Partial<AdminSettings>): Promise<AdminSettings> {
  const state = await mutateState((current) => {
    current.settings = {
      maintenanceMode: typeof patch.maintenanceMode === "boolean" ? patch.maintenanceMode : current.settings.maintenanceMode,
      maintenanceMessage: typeof patch.maintenanceMessage === "string"
        ? patch.maintenanceMessage.trim().slice(0, 500) || defaults.settings.maintenanceMessage
        : current.settings.maintenanceMessage,
      emptyRoomTimeoutSeconds: typeof patch.emptyRoomTimeoutSeconds === "number" && Number.isFinite(patch.emptyRoomTimeoutSeconds)
        ? Math.max(30, Math.min(900, Math.round(patch.emptyRoomTimeoutSeconds)))
        : current.settings.emptyRoomTimeoutSeconds,
    };
  });
  return state.settings;
}

export async function getMetricSnapshots(): Promise<MetricSnapshot[]> {
  return (await readState()).metrics;
}

export async function appendMetricSnapshot(snapshot: MetricSnapshot): Promise<void> {
  await mutateState((state) => {
    const last = state.metrics[state.metrics.length - 1];
    if (last && Date.now() - new Date(last.at).getTime() < 55_000) return;
    state.metrics.push(snapshot);
    state.metrics = state.metrics.slice(-10080);
  });
}
