export default function HistoricosPage() {
  return (
    <div>
      <h1 className="text-[22px] font-bold tracking-tight mb-1">Históricos &amp; análisis</h1>
      <div className="text-[var(--muted)] text-[13px] mb-6">
        Tu lugar para verificar, comparar y formarte tu propia opinión sobre lo que está pasando.
      </div>
      <Stub />
    </div>
  );
}

function Stub() {
  return (
    <div className="bg-white border border-dashed border-[var(--line)] rounded-xl p-12 text-center text-[var(--muted)]">
      <div className="text-3xl mb-2">📊</div>
      <div className="font-semibold text-[var(--ink)] mb-1">Tab structure ready, charts wire-up next</div>
      <div className="text-[12px] max-w-md mx-auto leading-relaxed">
        Se cargará en el siguiente push: 3 sub-tabs (Por KPI · Por hub · Comparativa MHs),
        top movers, drill-down per entity, anomaly band charts, correlations, heatmap.
        Datos vienen de <code className="bg-slate-100 px-1.5 py-0.5 rounded text-[11px]">kpi_snapshots</code> y
        <code className="bg-slate-100 px-1.5 py-0.5 rounded text-[11px] ml-1">peer_comparisons</code> una vez que el upload pipeline esté ingestando.
      </div>
    </div>
  );
}
