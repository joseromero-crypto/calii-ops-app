'use client';

import { useState } from 'react';
import { Sidebar } from '@/components/Sidebar';

export function MobileHeader({ userEmail }: { userEmail: string }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* Top bar — visible on mobile only */}
      <div className="lg:hidden sticky top-0 z-40 bg-black flex items-center justify-between px-4 h-12 border-b border-slate-800">
        <div className="flex items-center gap-1.5">
          <span className="wordmark" style={{ fontSize: 22, letterSpacing: -0.5 }}>calii</span>
          <span className="text-[9px] tracking-[2px] uppercase text-slate-500 self-end mb-0.5">ops</span>
        </div>
        <button
          onClick={() => setOpen(true)}
          className="p-2 rounded-lg hover:bg-slate-800 transition-colors text-slate-300"
          aria-label="Abrir menú"
        >
          <svg viewBox="0 0 24 24" width={20} height={20} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
      </div>

      {/* Dark overlay */}
      <div
        className={`fixed inset-0 z-40 bg-black/60 lg:hidden transition-opacity duration-200 ${
          open ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
        onClick={() => setOpen(false)}
      />

      {/* Slide-in drawer */}
      <div
        className={`fixed inset-y-0 left-0 z-50 w-[260px] lg:hidden transition-transform duration-300 ease-in-out ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <Sidebar userEmail={userEmail} onClose={() => setOpen(false)} />
      </div>
    </>
  );
}
