import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

let supabase: SupabaseClient | null = null;

if (supabaseUrl && supabaseAnonKey) {
  supabase = createClient(supabaseUrl, supabaseAnonKey);
} else {
  // eslint-disable-next-line no-console
  console.warn(
    'Supabase environment variables (VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY) are missing. Auth UI will be disabled.'
  );
}

export { supabase };
export const isSupabaseConfigured = () => Boolean(supabase);

