import { Sidebar } from '@/components/Sidebar';
import { MobileHeader } from '@/components/MobileHeader';
import { createServerClient } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  const userEmail = user?.email ?? process.env.APP_OWNER_EMAIL ?? 'jose.romero@calii.com';

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[232px_1fr]">
      {/* Desktop sidebar — hidden on mobile */}
      <div className="hidden lg:block">
        <Sidebar userEmail={userEmail} />
      </div>
      {/* Mobile top bar + hamburger drawer — hidden on desktop */}
      <MobileHeader userEmail={userEmail} />
      <main className="px-4 pt-4 pb-14 lg:px-9 lg:pt-7 min-w-0">{children}</main>
    </div>
  );
}
