package spec

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/kpmg/agent-qa/control-plane/internal/graph"
	"github.com/kpmg/agent-qa/control-plane/internal/openapi"
)

// attachEndpoints puts one `endpoint` node per operation in the latest graph of every environment of the project
// (creating a first graph when an environment has none) and links it to its contract requirement with confidence 1.
// Links of the previous spec version are replaced, so removed operations stop being covered (and tested) while their
// nodes, and the history attached to them, stay.
func attachEndpoints(ctx context.Context, tx pgx.Tx, org, projectID uuid.UUID, ops []openapi.Operation, reqs map[string]uuid.UUID) error {
	envIDs, err := New(tx).ListProjectEnvironmentIDs(ctx, ListProjectEnvironmentIDsParams{OrganizationID: org, ProjectID: projectID})
	if err != nil {
		return fmt.Errorf("list environments: %w", err)
	}
	gq := graph.New(tx)
	for _, envID := range envIDs {
		g, err := gq.GetLatestGraph(ctx, graph.GetLatestGraphParams{OrganizationID: org, EnvironmentID: envID})
		if err == pgx.ErrNoRows {
			version, verr := gq.NextGraphVersion(ctx, graph.NextGraphVersionParams{OrganizationID: org, EnvironmentID: envID})
			if verr != nil {
				return fmt.Errorf("next graph version: %w", verr)
			}
			g, err = gq.CreateGraph(ctx, graph.CreateGraphParams{OrganizationID: org, ProjectID: projectID, EnvironmentID: envID, Version: version})
		}
		if err != nil {
			return fmt.Errorf("graph for environment: %w", err)
		}
		if err := gq.DeleteAgentLinksOfEndpoints(ctx, graph.DeleteAgentLinksOfEndpointsParams{OrganizationID: org, GraphID: g.ID}); err != nil {
			return fmt.Errorf("clear endpoint links: %w", err)
		}
		for _, op := range ops {
			meta, _ := json.Marshal(map[string]any{"operation": op})
			n, err := gq.UpsertEndpointNode(ctx, graph.UpsertEndpointNodeParams{OrganizationID: org, GraphID: g.ID, Fingerprint: op.Key(), Label: op.Key(), Metadata: meta})
			if err != nil {
				return fmt.Errorf("upsert endpoint node: %w", err)
			}
			if err := gq.LinkEndpointRequirement(ctx, graph.LinkEndpointRequirementParams{OrganizationID: org, RequirementID: reqs[op.Key()], NodeID: n.ID}); err != nil {
				return fmt.Errorf("link endpoint: %w", err)
			}
		}
	}
	return nil
}
