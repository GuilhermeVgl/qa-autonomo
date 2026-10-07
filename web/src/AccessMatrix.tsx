import { useMemo } from "react";
import { buildAccess, worstResult } from "./access";
import type { GraphNode } from "./api";
import { toneOf, TONE_LABEL, type NodeCoverage, type NodeResult } from "./tone";

/**
 * Who sees what. Each row is a screen, each column a user, and a dot says that the user reaches it and how its last test
 * went. A screen not every user reaches is an alternative flow: it comes first, because it is the one that needs its own test.
 */
export function AccessMatrix({
  nodes,
  coverage,
  results,
  onSelect,
}: {
  nodes: GraphNode[];
  coverage: Record<string, NodeCoverage> | undefined;
  results: Record<string, NodeResult> | undefined;
  onSelect: (n: GraphNode) => void;
}) {
  const access = useMemo(() => buildAccess(nodes), [nodes]);
  if (access.users.length === 0) return <p className="meta access-empty">Nenhuma tela com usuário ainda. Explore a aplicação com pelo menos um usuário cadastrado.</p>;

  return (
    <div className="access" aria-label="Acesso por usuário">
      <p className="access-summary">
        {access.users.length === 1
          ? "Só um usuário foi explorado. Cadastre outros em Configurações → Credenciais para descobrir fluxos alternativos."
          : access.partialCount === 0
            ? "Todos os usuários alcançam as mesmas telas."
            : `${access.partialCount} ${access.partialCount === 1 ? "tela é alcançada" : "telas são alcançadas"} só por alguns usuários: fluxos alternativos.`}
      </p>
      <div className="access-scroll">
        <table className="table access-table">
          <thead>
            <tr>
              <th scope="col">Tela</th>
              {access.users.map((u) => (
                <th key={u} scope="col">
                  {u}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {access.rows.map((row) => (
              <tr key={`${row.kind}|${row.route}`} className={row.partial ? "partial" : ""}>
                <th scope="row">
                  {row.route}
                  {row.partial && <span className="pill status-reopened"> alternativo</span>}
                </th>
                {access.users.map((u) => {
                  const cell = row.cells[u];
                  if (!cell) {
                    return (
                      <td key={u} className="no-access" aria-label={`${u} não alcança ${row.route}`}>
                        —
                      </td>
                    );
                  }
                  const first = cell[0] as GraphNode;
                  const tone = toneOf(false, worstResult(cell, results), cell.map((n) => coverage?.[n.id]).find((c) => c !== undefined));
                  return (
                    <td key={u}>
                      <button type="button" className="cell-btn" aria-label={`${u} em ${row.route}: ${TONE_LABEL[tone]}`} onClick={() => onSelect(first)}>
                        <i className={`dot tone-${tone}`} />
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
