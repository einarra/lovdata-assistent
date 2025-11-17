import { getSupabaseAdminClient } from '../services/supabaseClient.js';

type SupabaseJwtPayload = {
  sub: string;
  role?: string;
  email?: string | null;
};

export async function verifySupabaseJwt(token: string): Promise<{ payload: SupabaseJwtPayload }> {
  if (!token) {
    throw new Error('Missing JWT');
  }

  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) {
    throw new Error(error?.message ?? 'Invalid Supabase token');
  }

  return {
    payload: {
      sub: data.user.id,
      role: data.user.role,
      email: data.user.email
    }
  };
}

