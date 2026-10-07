import type { Box } from "./flows";
import { NO_USER } from "./flows";
import type { GraphNode } from "./api";
import { Icon } from "./icons";
import { roleColor } from "./roles";
import { TONE_LABEL, type Tone } from "./tone";
import { useThumbnail } from "./useThumbnail";

export const userLabel = (user: string): string => (user === NO_USER ? "sem usuário" : user);

/** The node whose picture represents the screen for a user: one that has a picture, else the first. */
export function primaryNode(nodes: GraphNode[], focusId?: string): GraphNode | undefined {
  return nodes.find((n) => n.id === focusId) ?? nodes.find((n) => n.has_thumbnail) ?? nodes[0];
}

export function Picture({ node, token }: { node: GraphNode | undefined; token: string }) {
  const { url, failed } = useThumbnail(node?.id, !!node?.has_thumbnail, token);
  if (url) return <img className="screen-pic" src={url} alt={`Tela ${node?.label ?? ""}`} loading="lazy" />;
  return (
    <div className="screen-pic is-empty" aria-hidden="true">
      {node?.has_thumbnail && !failed ? <span className="spinner sm" /> : <Icon name="file" size={26} />}
    </div>
  );
}

function observed(node: GraphNode | undefined): { statuses: number[]; blocked: boolean } {
  const o = (node?.metadata["observed"] ?? {}) as { statuses?: number[]; blocked?: boolean };
  return { statuses: Array.isArray(o.statuses) ? o.statuses : [], blocked: o.blocked === true };
}

/**
 * One screen as one user sees it: its picture, route, who it is for and how its last test went. The same route for two users
 * is two cards, so "same screen, different permission" is two things side by side; a user who does not reach it gets a ghost.
 */
export function ScreenCard({ box, tone, token, selected, onSelect, focusId }: { box: Box; tone: Tone; token: string; selected: boolean; onSelect: () => void; focusId?: string }) {
  const color = roleColor(box.user);
  const style = { "--role": color } as React.CSSProperties;
  const label = userLabel(box.user);

  if (box.ghost) {
    return (
      <div className="screen-card is-ghost" style={style} aria-label={`${label} não alcança ${box.screen.route}`}>
        <Icon name="lock" size={22} />
        <strong>{box.screen.route}</strong>
        <span className="meta">{label} não alcança esta tela</span>
      </div>
    );
  }

  const node = primaryNode(box.nodes, focusId);
  if (box.screen.kind === "endpoint") {
    const o = observed(node);
    return (
      <button type="button" className={`screen-card is-endpoint tone-${tone}${selected ? " is-selected" : ""}`} style={style} onClick={onSelect} aria-label={`${box.screen.route}, chamada da API`}>
        <span className="endpoint-line">
          <span className="pill">API</span>
          <strong className="clip">{box.screen.route}</strong>
        </span>
        <span className="meta clip">
          {o.blocked ? "bloqueada pela política do ambiente" : o.statuses.length > 0 ? `respondeu ${o.statuses.join(", ")}` : "chamada observada"}
        </span>
      </button>
    );
  }

  return (
    <button type="button" className={`screen-card tone-${tone}${selected ? " is-selected" : ""}`} style={style} onClick={onSelect} aria-label={`${label} em ${box.screen.route}: ${TONE_LABEL[tone]}`}>
      <Picture node={node} token={token} />
      <span className="screen-meta">
        <strong className="clip">{box.screen.kind === "modal" ? box.screen.route.split(" › ").pop() : box.screen.route}</strong>
        <span className="screen-line">
          <span className="user-chip" style={{ background: color }}>
            {label}
          </span>
          <span className="screen-tone">
            <i className={`dot tone-${tone}`} /> {TONE_LABEL[tone]}
          </span>
        </span>
        {box.screen.kind === "page" && (
          <span className={`req-badge${box.screen.requirements.length === 0 && !(node?.requirement_count ?? 0) ? " none" : ""}`} title={box.screen.requirements.length > 0 ? `Requisitos: ${box.screen.requirements.join(", ")}` : "Nenhum requisito cobre esta tela"}>
            {box.screen.requirements.length > 0
              ? `${box.screen.requirements[0]}${box.screen.requirements.length > 1 ? ` +${box.screen.requirements.length - 1}` : ""}`
              : (node?.requirement_count ?? 0) > 0
                ? `${node?.requirement_count} requisito(s)`
                : "sem requisito"}
          </span>
        )}
        {box.only.length > 0 && (
          <span className="diff-badge" title={`Só ${label} tem: ${box.only.join(", ")}`}>
            + só {label}: {box.only.slice(0, 2).join(", ")}
            {box.only.length > 2 ? ` +${box.only.length - 2}` : ""}
          </span>
        )}
      </span>
    </button>
  );
}
