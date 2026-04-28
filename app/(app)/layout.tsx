import { Sidebar } from '@/components/Sidebar';
import { createServerClient } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = createServerClient();
  const { data: { user } } = await supabase.auth.getUser();

  return (
    <div className="grid grid-cols-[232px_1fr] min-h-screen">
      <Sidebar userEmail={user?.email ?? process.env.APP_OWNER_EMAIL ?? 'jose.romero@calii.com'} />
      <main className="px-9 pt-7 pb-14 min-w-0">{children}</main>
    </div>
  );
}
