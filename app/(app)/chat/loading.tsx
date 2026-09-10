export default function ChatLoading() {
  return (
    <div className="animate-pulse h-[calc(100vh-56px)] lg:h-[calc(100vh-56px)] grid grid-cols-[220px_1fr] lg:grid-cols-[240px_1fr_360px] gap-4 -mt-1">
      <div className="bg-gray-100 rounded-xl hidden lg:block" />
      <div className="bg-gray-100 rounded-xl" />
      <div className="bg-gray-100 rounded-xl hidden lg:block" />
    </div>
  );
}
