'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase';
import { useRouter } from 'next/navigation';

export function LoginForm({ redirectTo }: { redirectTo: string }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const router = useRouter();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        setErr(error.message === 'Invalid login credentials' ? 'Email o password incorrectos' : error.message);
      } else {
        router.push(redirectTo);
        router.refresh();
      }
    } catch (e: any) {
      setErr(e.message ?? 'Error desconocido');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <label className="block">
        <span className="text-[11px] uppercase tracking-wide text-[var(--muted)] font-bold">Email</span>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoComplete="email"
          className="mt-1 block w-full border border-[var(--line)] rounded-md px-3 py-2 text-[13.5px] focus:outline-none focus:border-teal-400"
        />
      </label>
      <label className="block">
        <span className="text-[11px] uppercase tracking-wide text-[var(--muted)] font-bold">Password</span>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoComplete="current-password"
          className="mt-1 block w-full border border-[var(--line)] rounded-md px-3 py-2 text-[13.5px] focus:outline-none focus:border-teal-400"
        />
      </label>

      {err && <div className="text-[12px] text-red-600 bg-red-50 border border-red-200 rounded-md p-2">{err}</div>}

      <button
        type="submit"
        disabled={busy || !email || !password}
        className="w-full bg-black text-white rounded-md py-2 text-[13px] font-semibold hover:bg-slate-800 disabled:opacity-50"
      >
        {busy ? 'Entrando…' : 'Entrar'}
      </button>
    </form>
  );
}
