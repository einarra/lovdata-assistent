import { useEffect, useState } from 'react';
import type { Session, AuthChangeEvent } from '@supabase/supabase-js';
import { supabase } from '../lib/supabaseClient';

export function useSupabaseSession() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(Boolean(supabase));
  const [configured] = useState(Boolean(supabase));
  const [authEvent, setAuthEvent] = useState<AuthChangeEvent | null>(null);

  useEffect(() => {
    if (!supabase) {
      setLoading(false);
      setSession(null);
      setAuthEvent(null);
      return;
    }

    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (active) {
        setSession(data.session ?? null);
        setLoading(false);
      }
    });

    const { data: listener } = supabase.auth.onAuthStateChange((event, newSession) => {
      setSession(newSession);
      setAuthEvent(event);
    });

    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  const clearAuthEvent = () => setAuthEvent(null);

  return { session, loading, configured, authEvent, clearAuthEvent };
}

