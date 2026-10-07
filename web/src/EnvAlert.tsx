import { currentBlock } from "./blocked";
import { Icon } from "./icons";
import { useWorkspace } from "./workspace";

/**
 * One notice, on every page, when the application is down or the login does not work: the two things that stop every test and
 * that a person has to fix before anything else means anything. It replaces what used to be a bug on every screen.
 */
export function EnvAlert() {
  const ws = useWorkspace();
  const block = ws.env ? currentBlock(ws.runs.data) : undefined;
  if (!block) return null;
  const down = block.blocked.kind === "app_down";
  return (
    <div className="env-alert" role="alert" aria-label="Aviso do ambiente">
      <Icon name="alert" size={20} />
      <div className="env-alert-text">
        <strong>{down ? "A aplicação está fora do ar" : "O login não funcionou"}</strong>
        <span>{block.blocked.message}</span>
      </div>
      <div className="env-alert-actions">
        {!down && (
          <button type="button" className="btn sm" onClick={() => ws.go("settings", "credenciais")}>
            Abrir credenciais
          </button>
        )}
        <button type="button" className="btn sm" onClick={() => ws.go("runs")}>
          Ver a execução
        </button>
      </div>
    </div>
  );
}
