package bug

import (
	"context"
	"fmt"
	"strings"

	"github.com/google/uuid"
)

// RecordInput describes one finished step on a node.
type RecordInput struct {
	OrganizationID  uuid.UUID
	ProjectID       uuid.UUID
	RunID           uuid.UUID
	StepID          uuid.UUID
	NodeID          uuid.UUID
	NodeFingerprint string
	NodeLabel       string
	Result          string // pass | fail | error | skipped
	Actual          string
	// Security is set when the step is a security check; the finding is then a bug of its own kind.
	Security *Security
}

// Record updates bugs from a finished step: a failure opens, recurs or reopens a bug; a pass fixes the open bugs
// of the node that did not occur in this run. Skipped steps change nothing. Run it in the step's transaction.
func Record(ctx context.Context, q *Queries, in RecordInput) error {
	switch in.Result {
	case "fail", "error":
		return recordFailure(ctx, q, in)
	case "pass":
		return recordPass(ctx, q, in)
	default:
		return nil
	}
}

func recordFailure(ctx context.Context, q *Queries, in RecordInput) error {
	if in.Security != nil {
		return recordSecurityFailure(ctx, q, in)
	}
	reqs, err := q.ListRequirementsForNode(ctx, ListRequirementsForNodeParams{OrganizationID: in.OrganizationID, ID: in.NodeID})
	if err != nil {
		return fmt.Errorf("list requirements for node: %w", err)
	}
	reqKey, severity := "", "normal"
	var reqID uuid.NullUUID
	if len(reqs) > 0 { // most critical requirement first
		reqKey, severity = reqs[0].Key, SeverityFor(reqs[0].Criticality)
		reqID = uuid.NullUUID{UUID: reqs[0].ID, Valid: true}
	}
	fp := RouteFingerprint(in.NodeLabel, reqKey, in.Actual)

	b, err := q.GetBugByFingerprint(ctx, GetBugByFingerprintParams{OrganizationID: in.OrganizationID, ProjectID: in.ProjectID, Fingerprint: fp})
	if isNoRows(err) {
		// a bug recorded before bugs were deduplicated across users: found by its old fingerprint and moved to the new one
		old, oldErr := q.GetBugByFingerprint(ctx, GetBugByFingerprintParams{OrganizationID: in.OrganizationID, ProjectID: in.ProjectID, Fingerprint: Fingerprint(in.NodeFingerprint, reqKey, in.Actual)})
		if oldErr == nil {
			if err := q.RenameBugFingerprint(ctx, RenameBugFingerprintParams{OrganizationID: in.OrganizationID, ID: old.ID, Fingerprint: fp}); err != nil {
				return fmt.Errorf("move bug to its new fingerprint: %w", err)
			}
			b, err = old, nil
		}
	}
	switch {
	case isNoRows(err):
		b, err = q.CreateBug(ctx, CreateBugParams{
			OrganizationID: in.OrganizationID, ProjectID: in.ProjectID, Fingerprint: fp, Title: title(reqKey, in.NodeLabel, in.Actual),
			Severity: severity, RequirementID: reqID, NodeID: uuid.NullUUID{UUID: in.NodeID, Valid: true}, NodeFingerprint: in.NodeFingerprint,
			FirstSeenRunID: in.RunID,
		})
		if err != nil {
			return fmt.Errorf("create bug: %w", err)
		}
	case err != nil:
		return fmt.Errorf("get bug: %w", err)
	default:
		status := b.Status
		if status == "fixed" {
			status = "reopened"
		}
		if _, err := q.MarkBugSeen(ctx, MarkBugSeenParams{OrganizationID: in.OrganizationID, ID: b.ID, Status: status, LastSeenRunID: in.RunID}); err != nil {
			return fmt.Errorf("mark bug seen: %w", err)
		}
	}
	if err := q.CreateOccurrence(ctx, CreateOccurrenceParams{OrganizationID: in.OrganizationID, BugID: b.ID, RunID: in.RunID, RunStepID: in.StepID}); err != nil {
		return fmt.Errorf("create occurrence: %w", err)
	}
	return nil
}

func recordSecurityFailure(ctx context.Context, q *Queries, in RecordInput) error {
	sec := in.Security
	fp := SecurityFingerprint(sec.Check, sec.Scope)
	b, err := q.GetBugByFingerprint(ctx, GetBugByFingerprintParams{OrganizationID: in.OrganizationID, ProjectID: in.ProjectID, Fingerprint: fp})
	switch {
	case isNoRows(err):
		category, check := "security", sec.Check
		b, err = q.CreateBug(ctx, CreateBugParams{
			OrganizationID: in.OrganizationID, ProjectID: in.ProjectID, Fingerprint: fp, Title: securityTitle(in.Actual),
			Severity: severityOrNormal(sec.Severity), NodeID: uuid.NullUUID{UUID: in.NodeID, Valid: true}, NodeFingerprint: in.NodeFingerprint,
			FirstSeenRunID: in.RunID, Category: &category, SecurityCheck: &check,
		})
		if err != nil {
			return fmt.Errorf("create security bug: %w", err)
		}
	case err != nil:
		return fmt.Errorf("get security bug: %w", err)
	default:
		status := b.Status
		if status == "fixed" {
			status = "reopened"
		}
		if _, err := q.MarkBugSeen(ctx, MarkBugSeenParams{OrganizationID: in.OrganizationID, ID: b.ID, Status: status, LastSeenRunID: in.RunID}); err != nil {
			return fmt.Errorf("mark security bug seen: %w", err)
		}
	}
	if err := q.CreateOccurrence(ctx, CreateOccurrenceParams{OrganizationID: in.OrganizationID, BugID: b.ID, RunID: in.RunID, RunStepID: in.StepID}); err != nil {
		return fmt.Errorf("create occurrence: %w", err)
	}
	return nil
}

// recordSecurityPass fixes a security bug when the very check that found it passes: a clean screen elsewhere, or a
// functional test that passes, says nothing about it.
func recordSecurityPass(ctx context.Context, q *Queries, in RecordInput) error {
	b, err := q.GetBugByFingerprint(ctx, GetBugByFingerprintParams{OrganizationID: in.OrganizationID, ProjectID: in.ProjectID, Fingerprint: SecurityFingerprint(in.Security.Check, in.Security.Scope)})
	if isNoRows(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("get security bug: %w", err)
	}
	if (b.Status == "new" || b.Status == "confirmed" || b.Status == "reopened") && b.LastSeenRunID != in.RunID {
		if err := q.MarkBugFixed(ctx, MarkBugFixedParams{OrganizationID: in.OrganizationID, ID: b.ID, FixedInRunID: uuid.NullUUID{UUID: in.RunID, Valid: true}}); err != nil {
			return fmt.Errorf("mark security bug fixed: %w", err)
		}
	}
	return nil
}

func severityOrNormal(s string) string {
	if s == "critical" || s == "high" {
		return s
	}
	return "normal"
}

// securityTitle is the finding itself, in a sentence the runner wrote for a person.
func securityTitle(actual string) string {
	t := "Segurança · " + strings.TrimSpace(actual)
	if len(t) > 200 {
		t = t[:200]
	}
	return t
}

func recordPass(ctx context.Context, q *Queries, in RecordInput) error {
	if in.Security != nil {
		return recordSecurityPass(ctx, q, in)
	}
	open, err := q.ListOpenBugsForNode(ctx, ListOpenBugsForNodeParams{OrganizationID: in.OrganizationID, ProjectID: in.ProjectID, NodeFingerprint: in.NodeFingerprint, LastSeenRunID: in.RunID})
	if err != nil {
		return fmt.Errorf("list open bugs: %w", err)
	}
	for _, b := range open {
		if err := q.MarkBugFixed(ctx, MarkBugFixedParams{OrganizationID: in.OrganizationID, ID: b.ID, FixedInRunID: uuid.NullUUID{UUID: in.RunID, Valid: true}}); err != nil {
			return fmt.Errorf("mark bug fixed: %w", err)
		}
	}
	return nil
}

// title names the route once: a generated requirement ("PAGE /x") would only repeat it.
func title(reqKey, label, actual string) string {
	var t string
	if reqKey != "" && !strings.HasSuffix(reqKey, " "+label) {
		t = reqKey + " · "
	}
	t += label + ": " + strings.TrimSpace(retryNote.ReplaceAllString(actual, ""))
	if len(t) > 200 {
		t = t[:200]
	}
	return t
}
