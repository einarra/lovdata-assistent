import 'dotenv/config';
import { getSupabaseAdminClient } from '../src/services/supabaseClient.js';

async function main() {
  const entries = process.argv.slice(2);

  if (entries.length === 0) {
    console.error('Usage: npm run create-supabase-users -- email[:password] ...');
    console.error('Provide each user as email or email:password. If password is omitted, DEFAULT_USER_PASSWORD env var is used.');
    process.exit(1);
  }

  const defaultPassword = process.env.DEFAULT_USER_PASSWORD ?? '';
  const supabase = getSupabaseAdminClient();

  for (const entry of entries) {
    const [email, providedPassword] = entry.split(':');
    const password = providedPassword || defaultPassword;

    if (!email) {
      console.warn(`Skipping entry "${entry}" – missing email.`);
      continue;
    }
    if (!password) {
      console.warn(`Skipping ${email} – no password provided and DEFAULT_USER_PASSWORD is not set.`);
      continue;
    }

    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true
    });

    if (error) {
      console.error(`Failed to create ${email}:`, error.message);
    } else {
      console.log(`Created/updated Supabase user: ${data.user?.id ?? email}`);
    }
  }
}

main().catch((error) => {
  console.error('Supabase user import failed:', error);
  process.exit(1);
});

