'use client';

import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useState } from 'react';
import clsx from 'clsx';
import { weekStartFriday, formatWeekRange } from '@/lib/types';

interface Props {
  /** ISO date (Friday) currently selected */
  selectedWeek: string;
  /** ISO date (Friday) of the most-recently-completed week — used as the "current" anchor */
  defaultWeek: string;
  /** Optional: list of weeks that already have at least one upload (for the dropdown) */
  weeksWithUploads?: { week_start: string; uploaded_count: number }[];
}

export function WeekSelector({ selectedWeek, defaultWeek, weeksWithUploads = [] }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const [showCustom, setShowCustom] = useState(false);

  function selectWeek(weekStart: string) {
    const params = new URLSearchParams();
    if (weekStart !== defaultWeek) {
      params.set('week', weekStart);
    }
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  // Generate the chip options: current, -1w, -2w, -3w, otra...
  const defaultDate = new Date(defaultWeek + 'T00:00:00');
  const chips: { weekStart: string; label: string; sublabel: string }[] = [];
  for (let i = 0; i < 4; i++) {
    const d = new Date(defaultDate);
    d.setDate(d.getDate() - 7 * i);
    const ws = d.toISOString().slice(0, 10);
    chips.push({
      weekStart: ws,
      label: i === 0 ? 'Actual' : i === 1 ? 'Anterior' : `${i} sem atrás`,
      sublabel: formatWeekRange(d),
    });
  }

  return (
    <div className="bg-white border border-[var(--line)] rounded-xl p-4 mb-5 shadow-soft">
      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
        <div>
          <div className="text-[10.5px] uppercase tracking-wide text-[var(--muted)] font-bold">
            Subiendo archivos para
          </div>
          <div className="text-[15px] font-semibold mt-0.5">
            {formatWeekRange(new Date(selectedWeek + 'T00:00:00'))}
          </div>
        </div>
        <button
          onClick={() => setShowCustom(s => !s)}
          className="text-[12px] text-teal-700 font-medium hover:underline"
        >
          {showCustom ? '× cerrar selector' : '＋ Seleccionar otra semana (backfill)'}
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        {chips.map(c => (
          <button
            key={c.weekStart}
            onClick={() => selectWeek(c.weekStart)}
            className={clsx(
              'px-3 py-1.5 rounded-full text-[12px] font-medium border transition-colors',
              c.weekStart === selectedWeek
                ? 'bg-black text-white border-black'
                : 'bg-white text-slate-700 border-slate-200 hover:border-black'
            )}
          >
            <span className="font-semibold">{c.label}</span>
            <span className="opacity-70 ml-1.5 text-[11px]">{c.sublabel.replace(/, \d{4}/, '')}</span>
          </button>
        ))}
      </div>

      {showCustom && (
        <div className="mt-4 pt-4 border-t border-slate-100">
          <div className="text-[11.5px] text-[var(--muted)] mb-2">
            Selecciona cualquier viernes pasado. Útil para subir datos históricos, recuperar de vacaciones,
            o re-subir una semana con archivo corregido. Re-subir un slot reemplaza la versión anterior.
          </div>
          <div className="flex items-center gap-2">
            <input
              type="date"
              defaultValue={selectedWeek}
              onChange={(e) => {
                const picked = new Date(e.target.value + 'T00:00:00');
                const fri = weekStartFriday(picked).toISOString().slice(0, 10);
                if (fri !== selectedWeek) selectWeek(fri);
              }}
              className="border border-slate-200 rounded-md px-2.5 py-1.5 text-[12.5px]"
            />
            <span className="text-[10.5px] text-[var(--muted)]">
              (la fecha seleccionada se ajusta automáticamente al viernes de esa semana)
            </span>
          </div>

          {weeksWithUploads.length > 0 && (
            <div className="mt-3">
              <div className="text-[10.5px] uppercase tracking-wide text-[var(--muted)] font-bold mb-1.5">
                Semanas con uploads existentes
              </div>
              <div className="flex flex-wrap gap-1.5">
                {weeksWithUploads.map(w => (
                  <button
                    key={w.week_start}
                    onClick={() => selectWeek(w.week_start)}
                    className={clsx(
                      'px-2.5 py-1 rounded-md text-[11px] font-medium border',
                      w.week_start === selectedWeek
                        ? 'bg-teal-700 text-white border-teal-700'
                        : 'bg-teal-50 text-teal-800 border-teal-200 hover:border-teal-700'
                    )}
                  >
                    {formatWeekRange(new Date(w.week_start + 'T00:00:00')).replace(/, \d{4}/, '')}
                    <span className="opacity-70 ml-1.5">({w.uploaded_count})</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
