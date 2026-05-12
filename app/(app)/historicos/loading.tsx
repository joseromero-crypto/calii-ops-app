// Next.js shows this file immediately when navigating to /historicos,
// while page.tsx fetches Supabase data in the background.
// The user sees the page shell right away instead of being stuck on the
// previous page.
export default function HistoricosLoading() {
  return (
    <div className="animate-pulse">
      {/* Header row */}
      <div className="flex items-baseline justify-between flex-wrap gap-3 mb-4">
        <div>
          <div className="h-7 w-52 bg-gray-200 rounded-md mb-2" />
          <div className="h-3.5 w-80 bg-gray-100 rounded" />
        </div>
        <div className="h-8 w-40 bg-gray-100 rounded-full" />
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-[var(--line)] mb-5">
        <div className="h-10 w-24 bg-gray-200 rounded-t-md" />
        <div className="h-10 w-36 bg-gray-100 rounded-t-md" />
        <div className="h-10 w-36 bg-gray-100 rounded-t-md" />
      </div>

      {/* KPI tile grid — mirrors the Por Hub default view */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 mb-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-44 bg-gray-100 rounded-xl" />
        ))}
      </div>

      {/* WoW chart strip */}
      <div className="h-5 w-40 bg-gray-200 rounded mb-3" />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="sm:col-span-2 h-48 bg-gray-100 rounded-xl" />
        <div className="h-44 bg-gray-100 rounded-xl" />
        <div className="h-44 bg-gray-100 rounded-xl" />
      </div>
    </div>
  );
}
