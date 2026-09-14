import React from 'react';

/**
 * Says out loud when the backend didn't answer, so an empty page reads as
 * "offline" rather than "nothing happened" or "silently full of fake rows".
 * No page falls back to invented data anymore — an unreachable backend
 * yields an empty list, not sample incidents dressed up as real ones.
 */
export const DataSourceBadge: React.FC<{ isMock: boolean; error?: string | null }> = ({
  isMock,
  error,
}) => {
  if (!isMock) {
    return (
      <span
        title="Served by the IBVAP backend"
        className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 text-[10px] font-mono uppercase tracking-wider"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
        Live data
      </span>
    );
  }
  return (
    <span
      title={error ? `Backend unreachable: ${error}` : 'Backend unreachable'}
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300 text-[10px] font-mono uppercase tracking-wider"
    >
      <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
      Backend unreachable — no data
    </span>
  );
};
