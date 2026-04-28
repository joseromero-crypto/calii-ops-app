import { LoginForm } from './LoginForm';

export const dynamic = 'force-dynamic';

interface PageProps { searchParams: { redirect?: string; error?: string } }

export default function LoginPage({ searchParams }: PageProps) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
      <div className="bg-white border border-[var(--line)] rounded-2xl shadow-soft p-8 w-full max-w-[380px]">
        <div className="text-center mb-6">
          <div className="wordmark mb-1">calii</div>
          <div className="text-[10px] tracking-[2px] uppercase text-slate-500">ops weekly</div>
        </div>

        {searchParams.error === 'unauthorized_account' && (
          <div className="bg-red-50 border border-red-200 text-red-800 text-[12.5px] rounded-md p-3 mb-4">
            Esta cuenta no está autorizada. Sólo el owner registrado puede acceder.
          </div>
        )}

        <LoginForm redirectTo={searchParams.redirect ?? '/upload'} />

        <p className="text-[11px] text-[var(--muted)] text-center mt-6">
          Acceso autorizado únicamente para Jose Romero.<br />
          Para soporte: mensaje a tu admin.
        </p>
      </div>
    </div>
  );
}
