export default function PrioridadesLoading() {
  return (
    <div className="animate-pulse">
      {/* Header */}
      <div className="h-7 w-40 bg-gray-200 rounded-md mb-2" />
      <div className="h-3.5 w-72 bg-gray-100 rounded mb-6" />

      {/* Category tab bar */}
      <div className="flex gap-1 border-b border-gray-200 mb-5">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-9 w-24 bg-gray-100 rounded-t-md" />
        ))}
      </div>

      {/* Insight cards */}
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-24 bg-gray-100 rounded-xl" />
        ))}
      </div>
    </div>
  );
}
