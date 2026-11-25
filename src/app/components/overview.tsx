export function WorkspaceOverview({ metrics }: {
  metrics: { label: string; value: number; tone?: 'blue' | 'amber' | 'green' }[];
}) {
  return <dl className="workspace-overview">
    {metrics.map(({ label, value, tone }) => <div className="workspace-metric" key={label}>
      <dt>{label}</dt>
      <dd data-tone={value ? tone : undefined}>{value.toLocaleString()}</dd>
    </div>)}
  </dl>;
}
