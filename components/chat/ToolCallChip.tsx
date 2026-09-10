'use client';

import { useState } from 'react';
import clsx from 'clsx';

export interface ToolCallView {
  key: string;
  tool_name: string;
  args: Record<string, unknown>;
  status: 'running' | 'done' | 'error';
  result?: unknown;
  duration_ms?: number | null;
}

/** BUILD.md Phase 4: "show each tool call as it runs, collapsed, expandable to its arguments and result." */
export function ToolCallChip({ call }: { call: ToolCallView }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="border border-[var(--line)] rounded-lg overflow-hidden bg-[var(--line-2)]/50">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-[11.5px] hover:bg-[var(--line-2)] transition-colors"
      >
        <StatusDot status={call.status} />
        <span className="font-mono font-medium text-[var(--ink-2)]">{call.tool_name}</span>
        {call.duration_ms != null && <span className="text-[var(--muted-2)]">{call.duration_ms}ms</span>}
        <span className="ml-auto text-[var(--muted-2)]">{open ? '−' : '+'}</span>
      </button>
      {open && (
        <div className="px-3 pb-2.5 pt-1 border-t border-[var(--line)] space-y-2">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-[var(--muted-2)] mb-0.5">Args</div>
            <pre className="text-[11px] bg-white border border-[var(--line)] rounded-md p-2 overflow-x-auto max-h-40">
              {JSON.stringify(call.args, null, 2)}
            </pre>
          </div>
          {call.status !== 'running' && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-[var(--muted-2)] mb-0.5">
                {call.status === 'error' ? 'Error' : 'Result'}
              </div>
              <pre className="text-[11px] bg-white border border-[var(--line)] rounded-md p-2 overflow-x-auto max-h-56">
                {typeof call.result === 'string' ? call.result : JSON.stringify(call.result, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatusDot({ status }: { status: ToolCallView['status'] }) {
  return (
    <span
      className={clsx(
        'w-1.5 h-1.5 rounded-full flex-none',
        status === 'running' && 'bg-amber-400 animate-pulse',
        status === 'done' && 'bg-emerald-500',
        status === 'error' && 'bg-red-500'
      )}
    />
  );
}
