'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import clsx from 'clsx';

const NAV = [
  {
    group: 'Operación semanal',
    items: [
      { href: '/upload',     label: 'Subir archivos', icon: UploadIcon },
      { href: '/historicos', label: 'Históricos',     icon: ChartIcon },
      { href: '/prioridades',label: 'Prioridades',    icon: ClockIcon },
    ],
  },
  {
    group: 'Configuración',
    items: [
      { href: '/config',     label: 'Configuración',  icon: CogIcon },
    ],
  },
] as const;

export function Sidebar({ userEmail = 'jose.romero@calii.com' }: { userEmail?: string }) {
  const pathname = usePathname() ?? '/';
  const initials = userEmail.split('@')[0].slice(0, 2).toUpperCase();

  return (
    <aside className="bg-black text-slate-300 w-[232px] sticky top-0 h-screen p-[22px_16px] flex flex-col">
      <div className="flex items-center gap-2 px-2 pb-[22px] border-b border-slate-800 mb-4">
        <span className="wordmark">calii</span>
        <span className="text-[11px] tracking-[2px] uppercase text-slate-500 self-end mb-1">ops</span>
      </div>

      <nav className="flex flex-col gap-1">
        {NAV.map((group) => (
          <div key={group.group}>
            <div className="text-[10px] tracking-[1.5px] uppercase text-slate-600 px-3 pt-[14px] pb-[6px]">
              {group.group}
            </div>
            {group.items.map(({ href, label, icon: Icon }) => {
              const active = pathname === href || pathname.startsWith(href + '/');
              return (
                <Link
                  key={href}
                  href={href}
                  className={clsx(
                    'flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-[13.5px] font-medium transition-colors',
                    active
                      ? 'bg-teal-400/10 text-teal-400'
                      : 'text-slate-300 hover:bg-slate-900 hover:text-white'
                  )}
                >
                  <Icon className={clsx('w-4 h-4 flex-none', active ? 'stroke-teal-400' : 'stroke-slate-400')} />
                  {label}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="mt-auto border-t border-slate-800 pt-3.5">
        <div className="flex items-center gap-2.5 mb-2">
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-teal-400 to-teal-700 text-black font-bold text-[13px] flex items-center justify-center">
            {initials}
          </div>
          <div className="text-[12px] leading-tight flex-1 min-w-0">
            <div className="text-slate-100 font-semibold truncate">{userEmail.split('@')[0]}</div>
            <div className="text-slate-500 text-[11px] truncate">{userEmail}</div>
          </div>
        </div>
        <form action="/api/auth/signout" method="post">
          <button
            type="submit"
            className="w-full text-left text-[11.5px] text-slate-400 hover:text-white hover:bg-slate-900 rounded px-2 py-1.5 transition-colors"
          >
            Cerrar sesión →
          </button>
        </form>
      </div>
    </aside>
  );
}

// Icons (inline SVG so we don't need a lib)
function UploadIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}
function ChartIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <polyline points="3 17 9 11 13 15 21 7" />
      <polyline points="14 7 21 7 21 14" />
    </svg>
  );
}
function ClockIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx={12} cy={12} r={9} />
      <polyline points="12 7 12 12 15 14" />
    </svg>
  );
}
function CogIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx={12} cy={12} r={3} />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  );
}
