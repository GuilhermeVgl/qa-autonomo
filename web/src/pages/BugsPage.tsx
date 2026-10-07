import { useState } from "react";
import { BugCard } from "../cards";
import { EmptyState, PageHeader, Segmented, Skeleton } from "../ui";
import { useWorkspace } from "../workspace";

type Filter = "open" | "fixed" | "false_positive" | "all";
type Kind = "all" | "functional" | "security";

export function BugsPage() {
  const ws = useWorkspace();
  const [filter, setFilter] = useState<Filter>("open");
  const [kind, setKind] = useState<Kind>("all");
  const all = ws.bugs;
  const shown = (all ?? [])
    .filter((b) => (filter === "all" ? true : filter === "open" ? b.status === "new" || b.status === "confirmed" || b.status === "reopened" : b.status === filter))
    .filter((b) => kind === "all" || (kind === "security") === (b.category === "security"));

  return (
    <div className="page">
      <PageHeader title="Bugs" subtitle="Defeitos deduplicados por impressão digital: o mesmo problema não vira dois cards.">
        <Segmented
          label="Filtrar bugs"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "open", label: `Abertos (${ws.openBugs.length})` },
            { value: "fixed", label: "Corrigidos" },
            { value: "false_positive", label: "Falsos positivos" },
            { value: "all", label: "Todos" },
          ]}
        />
        <Segmented
          label="Tipo de bug"
          value={kind}
          onChange={setKind}
          options={[
            { value: "all", label: "Todos os tipos" },
            { value: "functional", label: `Funcionais (${ws.openFunctional.length})` },
            { value: "security", label: `Segurança (${ws.openSecurity.length})` },
          ]}
        />
      </PageHeader>
      {!all ? (
        <div className="card skeleton-rows">
          {[0, 1].map((i) => (
            <Skeleton key={i} height={64} radius={12} />
          ))}
        </div>
      ) : shown.length === 0 ? (
        <section className="card">
          <EmptyState icon="check" title={filter === "open" ? "Nenhum bug aberto" : "Nada por aqui"} text="Quando uma regressão falhar, o bug aparece aqui com o histórico das ocorrências." />
        </section>
      ) : (
        <div className="bug-grid">
          {shown.map((b) => (
            <section className="card bug-card" key={b.id} aria-label={`Bug ${b.title}`}>
              <BugCard bug={b} token={ws.token} onDone={ws.refreshBugs} />
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
