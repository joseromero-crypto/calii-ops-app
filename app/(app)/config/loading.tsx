export default function ConfigLoading() {
  return (
    <div className="animate-pulse max-w-2xl">
      {/* Header */}
      <div className="h-7 w-44 bg-gray-200 rounded-md mb-2" />
      <div className="h-3.5 w-60 bg-gray-100 rounded mb-6" />

      {/* Config sections */}
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="mb-6">
          <div className="h-5 w-32 bg-gray-200 rounded mb-3" />
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, j) => (
              <div key={j} className="h-12 bg-gray-100 rounded-lg" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
