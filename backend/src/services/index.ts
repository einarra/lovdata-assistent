import { env } from '../config/env.js';
import { LovdataClient } from './lovdataClient.js';
import { SerperClient } from './serperClient.js';
import type { SupabaseArchiveStore } from '../storage/supabaseArchiveStore.js';

export type ServiceRegistry = {
  lovdata: LovdataClient;
  archive?: SupabaseArchiveStore | null;
  serper?: SerperClient;
};

const lovdataClient = new LovdataClient();
const serperClient = env.SERPER_API_KEY ? new SerperClient() : undefined;
let archiveStore: SupabaseArchiveStore | null = null;

export function getServices(): ServiceRegistry {
  return {
    lovdata: lovdataClient,
    archive: archiveStore,
    serper: serperClient
  };
}

export function setArchiveStore(store: SupabaseArchiveStore | null) {
  archiveStore = store;
}
