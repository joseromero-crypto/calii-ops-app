export default function UploadLoading() {
  return (
    <div className="animate-pulse max-w-3xl">
      {/* Header */}
      <div className="h-7 w-44 bg-gray-200 rounded-md mb-2" />
      <div className="h-3.5 w-64 bg-gray-100 rounded mb-6" />

      {/* Week selector bar */}
      <div className="h-10 w-full bg-gray-100 rounded-xl mb-6" />

      {/* Upload cards grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-28 bg-gray-100 rounded-xl" />
        ))}
      </div>

      {/* Recompute button area */}
      <div className="h-10 w-48 bg-gray-200 rounded-lg" />
    </div>
  );
}
