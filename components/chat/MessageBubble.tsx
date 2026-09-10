'use client';

import clsx from 'clsx';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ClaimRow } from '@/lib/chat/types';

const CITATION_RE = /\[c(\d+)\]/g;

/**
 * The model's prose is markdown (headers/bold/tables — confirmed heavily
 * used in real testing) and carries [cN] claim citations (BUILD.md Phase 4
 * ⭐). Rather than write a custom remark plugin to intercept citations
 * inline, rewrite them into markdown link syntax before rendering —
 * `[c1]` → `[c1](claim:c1)` — then override link rendering to turn
 * `claim:` hrefs into clickable claim chips. A normal `[text](url)` link
 * the model might still emit renders as an ordinary link, untouched.
 */
function toMarkdownWithClaimLinks(text: string): string {
  return text.replace(CITATION_RE, (_, n) => `[c${n}](claim:c${n})`);
}

export function MessageContent({
  text, claims, onClaimClick, activeClaimId,
}: {
  text: string;
  claims: ClaimRow[];
  onClaimClick: (claim: ClaimRow) => void;
  activeClaimId?: string | null;
}) {
  const claimByRef = new Map(claims.map((c) => [c.claim_ref, c]));

  return (
    <div className="chat-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // react-markdown sanitizes hrefs by default (XSS guard) and strips
        // any protocol it doesn't recognise — silently empties `claim:` URIs
        // (found via a live click-through-to-nowhere: the anchor rendered
        // with href="", no error). Allow `claim:` through explicitly;
        // everything else still goes through the default sanitizer.
        urlTransform={(url) => (url.startsWith('claim:') ? url : defaultUrlTransform(url))}
        components={{
          a: ({ href, children: linkChildren }) => {
            if (href?.startsWith('claim:')) {
              const ref = href.slice('claim:'.length);
              const claim = claimByRef.get(ref);
              if (!claim) {
                return (
                  <span className="text-red-500 font-mono text-[11px]" title="Sin evidencia asociada — posible bug en el tool que la produjo">
                    [{ref}⚠]
                  </span>
                );
              }
              return (
                <button
                  onClick={() => onClaimClick(claim)}
                  title={claim.text}
                  className={clsx(
                    'inline-flex items-center justify-center align-super text-[9.5px] font-semibold rounded px-1 mx-0.5 -translate-y-px transition-colors',
                    claim.id === activeClaimId ? 'bg-teal-400 text-black' : 'bg-teal-400/15 text-teal-700 hover:bg-teal-400/30'
                  )}
                >
                  {ref}
                </button>
              );
            }
            return <a href={href} target="_blank" rel="noreferrer" className="text-teal-600 underline">{linkChildren}</a>;
          },
        }}
      >
        {toMarkdownWithClaimLinks(text)}
      </ReactMarkdown>
    </div>
  );
}

export function MessageBubble({
  role, children,
}: { role: 'user' | 'assistant'; children: React.ReactNode }) {
  if (role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[75%] bg-[var(--ink)] text-white rounded-2xl rounded-br-sm px-4 py-2.5 text-[13.5px] leading-relaxed whitespace-pre-wrap">
          {children}
        </div>
      </div>
    );
  }
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] bg-white border border-[var(--line)] rounded-2xl rounded-bl-sm px-4 py-3 text-[13.5px] leading-relaxed">
        {children}
      </div>
    </div>
  );
}
