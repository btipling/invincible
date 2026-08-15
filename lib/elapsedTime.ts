/**
 * Whole-turn Busy clock (#347 / plan #457).
 *
 * The live `mm:ss` on the host DOM Busy chip is the operator's turn timer: it is
 * *client wall-clock time* from the moment a turn goes Busy, NOT the provider's
 * `usage`/latency duration (which may not reflect wall-clock at all). It runs
 * on the DOM status chip (`HarnessHost` `AppNav`), so it needs no server
 * timestamp and no Wasm/bridge involvement.
 */

/**
 * Format elapsed seconds as `mm:ss` (`0:05`, `1:02`, `12:07`) and `h:mm:ss`
 * (`1:02:03`) once past an hour. Clamps negative/`NaN` input to `0:00` so a
 * host clock edge can never print a stray `-1:-1` or `NaN:NaN` in the chip.
 */
export function formatElapsedSeconds(totalSec: number): string {
  const s = Number.isFinite(totalSec) ? Math.max(0, Math.floor(totalSec)) : 0;
  const sec = String(s % 60).padStart(2, '0');
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) {
    const mm = String(m % 60).padStart(2, '0');
    return `${h}:${mm}:${sec}`;
  }
  return `${m}:${sec}`;
}
