/**
 * Start a Netlify background function FROM THE BROWSER.
 *
 * Session 18 (2026-09-18). Both background paths — `/api/recompute` and
 * `/api/chat/start` — used to invoke their function server-side, with
 * `fetch(`${process.env.URL}/.netlify/functions/<name>`)` from inside the Next
 * server handler. That does not work on this site, and it fails in the worst
 * possible way: the call comes back 2xx, so the route reports success and
 * writes a run row, but the function is never invoked.
 *
 * Measured on 2026-09-18, production:
 *   - recompute_runs had one row: week 2026-09-11, status 'running',
 *     phase null since 20:46:05Z — phase is set by the function's very first
 *     write, so it never ran.
 *   - Netlify function logs for `recompute-background` AND `chat-background`:
 *     zero invocations in 7 days, i.e. since the day both were deployed.
 *   - The same POST, issued from the browser to the same relative path,
 *     invoked the function immediately (log entry, 202 in ~850 ms).
 *
 * So the endpoint, the bundle and the deploy are all fine; what does not work
 * is one function on this site invoking another over HTTP. The browser does
 * the invoking now. What the browser is trusted with is only the single-use
 * `run_token` the API route just minted for it behind session auth — the
 * function still claims that token with a conditional update and clears it in
 * the same statement, so a replay cannot start a second run.
 *
 * NOTE: these paths only exist when the site is served through Netlify — in
 * production, or locally via `npm run dev` (netlify dev, port 8888). Under a
 * bare `next dev` on 3000 there is no /.netlify/functions/* and this throws,
 * which is the honest outcome: nothing would have run there either.
 */
export type BackgroundFn = 'recompute-background' | 'chat-background';

export async function kickBackground(
  fn: BackgroundFn,
  payload: Record<string, unknown>,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`/.netlify/functions/${fn}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`no se pudo iniciar el proceso en segundo plano: ${message}`);
  }

  // Background functions answer 202 with no body. Anything else means the
  // invocation was not accepted — 404 is the usual one (served by `next dev`
  // instead of Netlify, or a deploy without the function).
  if (res.status !== 202 && !res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `no se pudo iniciar el proceso en segundo plano (HTTP ${res.status}). ${detail.slice(0, 200)}`.trim(),
    );
  }
}
