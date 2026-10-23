// Package brief builds the general report of an environment: facts computed from what the platform knows (map, specs,
// runs, bugs), the mismatches between flows and specifications, and a narrative written from those facts, by a model when
// there is one and by a template always.
package brief

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/kpmg/agent-qa/control-plane/internal/graph"
	"github.com/kpmg/agent-qa/control-plane/internal/report"
	"github.com/kpmg/agent-qa/control-plane/internal/spec"
)

type envInfo struct {
	Name, BaseURL, Policy, Kind, Device string
}

type reqRow struct {
	SpecTitle, Source, Key, Text, Criticality string
	NodeIDs                                   []uuid.UUID
}

type runInfo struct {
	ID         uuid.UUID
	Type       string
	Status     string
	FinishedAt time.Time
	Summary    json.RawMessage
}

type regressionInfo struct {
	ID         uuid.UUID
	FinishedAt time.Time
	GraphID    uuid.UUID
	Roles      []string
	Report     report.Report
}

type bugRow struct {
	Title, Severity, Status string
	// Category is "functional" (a test failed) or "security" (a security check found it).
	Category string
	Users    []string
}

// input is everything the analysis needs, already loaded: analyze is pure, so the rules are tested without a database.
type input struct {
	Now         time.Time
	Project     string
	Env         envInfo
	GraphID     uuid.UUID
	Nodes       []graph.Node
	NodeResults map[uuid.UUID]string
	Edges       []graph.Edge
	Reqs        []reqRow
	Exploration *runInfo
	// Latest is the most recent run that finished, of any kind: whether the last attempt could do its job.
	Latest     *runInfo
	Regression *regressionInfo
	Bugs       []bugRow
	Pendencies int
	Runners    int
	LLM        bool
	Storage    bool
}

// ---- what the report says ----

type EnvFacts struct {
	Name    string `json:"name"`
	BaseURL string `json:"base_url"`
	Policy  string `json:"destructive_policy"`
	Kind    string `json:"kind"`
	Device  string `json:"device,omitempty"`
}

type MapFacts struct {
	Explored  bool `json:"explored"`
	Pages     int  `json:"pages"`
	Screens   int  `json:"screens"`
	Modals    int  `json:"modals"`
	Endpoints int  `json:"endpoints"`
	Commands  int  `json:"commands"`
	// WithPicture is how many page nodes have a picture of their screen.
	WithPicture   int            `json:"with_picture"`
	LastExplored  *time.Time     `json:"last_explored,omitempty"`
	LoginFailures []string       `json:"login_failures,omitempty"`
	ScreensByUser map[string]int `json:"screens_by_user"`
}

type SpecFacts struct {
	Title         string         `json:"title"`
	Source        string         `json:"source"`
	Requirements  int            `json:"requirements"`
	ByCriticality map[string]int `json:"by_criticality"`
	Unlinked      int            `json:"unlinked"`
	NeedReview    int            `json:"need_review"`
}

type UnlinkedRequirement struct {
	Spec        string `json:"spec"`
	Key         string `json:"key"`
	Text        string `json:"text"`
	Criticality string `json:"criticality"`
}

type CoverageFacts struct {
	Requirements        int                   `json:"requirements"`
	Linked              int                   `json:"linked"`
	PercentRequirements int                   `json:"percent_requirements"`
	Unlinked            []UnlinkedRequirement `json:"unlinked"`
	UnlinkedTotal       int                   `json:"unlinked_total"`
	Screens             int                   `json:"screens"`
	ScreensCovered      int                   `json:"screens_covered"`
	PercentScreens      int                   `json:"percent_screens"`
	// ScreensWithoutRequirement are routes no requirement of any spec is linked to.
	ScreensWithoutRequirement      []string `json:"screens_without_requirement"`
	ScreensWithoutRequirementTotal int      `json:"screens_without_requirement_total"`
}

type FailingRequirement struct {
	Key          string   `json:"key"`
	Text         string   `json:"text"`
	Criticality  string   `json:"criticality"`
	FailingUsers []string `json:"failing_users"`
}

type RegressionFacts struct {
	FinishedAt          time.Time            `json:"finished_at"`
	Passed              int                  `json:"passed"`
	Failed              int                  `json:"failed"`
	Errored             int                  `json:"errored"`
	Skipped             int                  `json:"skipped"`
	Users               []report.UserOutcome `json:"users"`
	TestedAs            []string             `json:"tested_as"`
	FailingRequirements []FailingRequirement `json:"failing_requirements"`
	// Stale: the run tested a version of the map that is no longer the latest.
	Stale bool `json:"stale"`
}

type BugItem struct {
	Title    string   `json:"title"`
	Severity string   `json:"severity"`
	Status   string   `json:"status"`
	Users    []string `json:"users"`
}

type BugFacts struct {
	Open     int       `json:"open"`
	Critical int       `json:"critical"`
	High     int       `json:"high"`
	Fixed    int       `json:"fixed"`
	List     []BugItem `json:"list"`
}

// BlockedFacts is what kept the latest run from doing its job. It is one problem for the person to fix (the application is
// down, or users could not log in), reported once, instead of a bug on every screen.
type BlockedFacts struct {
	Kind    string    `json:"kind"` // app_down | login_failed
	Message string    `json:"message"`
	Roles   []string  `json:"roles,omitempty"`
	RunType string    `json:"run_type"`
	At      time.Time `json:"at"`
}

// SecurityFacts is what the security checks found. They run inside every exploration and regression, so the numbers come
// from the last run that made them, and the findings are bugs of their own kind.
type SecurityFacts struct {
	// Checked says whether any run made the checks (older runs, and runs that turned them off, did not).
	Checked bool `json:"checked"`
	Checks  int  `json:"checks"`
	Failed  int  `json:"failed"`
	// Probes are the addresses with parameters on which injections were tried (reads only).
	Probes   int       `json:"probes"`
	Open     int       `json:"open"`
	Critical int       `json:"critical"`
	High     int       `json:"high"`
	Normal   int       `json:"normal"`
	Fixed    int       `json:"fixed"`
	List     []BugItem `json:"list"`
}

// AccessFact is a screen some users reach and others do not: an alternative flow.
type AccessFact struct {
	Route      string   `json:"route"`
	Users      []string `json:"users"`
	MissingFor []string `json:"missing_for"`
}

type JourneyFacts struct {
	Count              int      `json:"count"`
	Routes             []string `json:"routes"`
	WithoutRequirement []string `json:"without_requirement"`
}

type CapabilityItem struct {
	Key            string `json:"key"`
	Name           string `json:"name"`
	Screens        int    `json:"screens"`
	ScreensCovered int    `json:"screens_covered"`
	ScreensTested  int    `json:"screens_tested"`
	Status         string `json:"status"` // pass | fail | error | skipped | untested
}

type CapabilityFacts struct {
	Total   int              `json:"total"`
	Covered int              `json:"covered"`
	Tested  int              `json:"tested"`
	Failing int              `json:"failing"`
	List    []CapabilityItem `json:"list"`
}

// Issue is something that does not add up, in the order it deserves attention.
type Issue struct {
	Code     string   `json:"code"`
	Severity string   `json:"severity"` // alta | média | baixa
	Area     string   `json:"area"`
	Message  string   `json:"message"`
	Items    []string `json:"items,omitempty"`
}

type Check struct {
	ID     string `json:"id"`
	Label  string `json:"label"`
	OK     bool   `json:"ok"`
	Detail string `json:"detail"`
}

// Facts is the report without the writing: numbers and lists that can be checked against the application.
type Facts struct {
	GeneratedAt    time.Time        `json:"generated_at"`
	Project        string           `json:"project"`
	Environment    EnvFacts         `json:"environment"`
	Users          []string         `json:"users"`
	Map            MapFacts         `json:"map"`
	Specs          []SpecFacts      `json:"specs"`
	Coverage       CoverageFacts    `json:"coverage"`
	Regression     *RegressionFacts `json:"regression"`
	Bugs           BugFacts         `json:"bugs"`
	Security       SecurityFacts    `json:"security"`
	Blocked        *BlockedFacts    `json:"blocked,omitempty"`
	Capabilities   CapabilityFacts  `json:"capabilities"`
	Access         []AccessFact     `json:"access"`
	Journeys       JourneyFacts     `json:"journeys"`
	OpenPendencies int              `json:"open_pendencies"`
	Issues         []Issue          `json:"issues"`
	Readiness      []Check          `json:"readiness"`
}

const maxListed = 25

func percent(part, whole int) int {
	if whole == 0 {
		return 0
	}
	return (part*100 + whole/2) / whole
}

func capped[T any](in []T) []T {
	if len(in) > maxListed {
		return in[:maxListed]
	}
	if in == nil {
		return []T{}
	}
	return in
}

type screen struct {
	route string
	users map[string]bool
	nodes []graph.Node
}

func analyze(in input) Facts {
	f := Facts{
		GeneratedAt: in.Now, Project: in.Project,
		Environment: EnvFacts{Name: in.Env.Name, BaseURL: in.Env.BaseURL, Policy: in.Env.Policy, Kind: in.Env.Kind, Device: in.Env.Device},
		Users:       []string{}, Specs: []SpecFacts{}, Access: []AccessFact{}, Security: SecurityFacts{List: []BugItem{}},
	}

	// ---- the map ----
	nodeByID := map[uuid.UUID]graph.Node{}
	screens := map[string]*screen{}
	var order []string
	userSet := map[string]bool{}
	f.Map.ScreensByUser = map[string]int{}
	for _, n := range in.Nodes {
		nodeByID[n.ID] = n
		switch n.Kind {
		case "page":
			f.Map.Pages++
			if n.ThumbnailKey != nil {
				f.Map.WithPicture++
			}
			sc := screens[n.Label]
			if sc == nil {
				sc = &screen{route: n.Label, users: map[string]bool{}}
				screens[n.Label] = sc
				order = append(order, n.Label)
			}
			sc.nodes = append(sc.nodes, n)
			for _, u := range n.AppRoles {
				sc.users[u] = true
				userSet[u] = true
			}
		case "modal":
			f.Map.Modals++
		case "endpoint":
			f.Map.Endpoints++
		case "command":
			f.Map.Commands++
		}
	}
	f.Map.Explored = len(in.Nodes) > 0
	f.Map.Screens = len(screens)
	for _, sc := range screens {
		for u := range sc.users {
			f.Map.ScreensByUser[u]++
		}
	}
	for u := range userSet {
		f.Users = append(f.Users, u)
	}
	sort.Strings(f.Users)
	if in.Exploration != nil {
		t := in.Exploration.FinishedAt
		f.Map.LastExplored = &t
		var s struct {
			LoginFailures []string `json:"login_failures"`
		}
		_ = json.Unmarshal(in.Exploration.Summary, &s)
		f.Map.LoginFailures = s.LoginFailures
	}

	// ---- specs and coverage ----
	linkedNode := map[uuid.UUID]bool{}
	specs := map[string]*SpecFacts{}
	var specOrder []string
	written := map[string][]spec.Item{}
	for _, r := range in.Reqs {
		sf := specs[r.SpecTitle]
		if sf == nil {
			sf = &SpecFacts{Title: r.SpecTitle, Source: r.Source, ByCriticality: map[string]int{}}
			specs[r.SpecTitle] = sf
			specOrder = append(specOrder, r.SpecTitle)
		}
		sf.Requirements++
		sf.ByCriticality[r.Criticality]++
		f.Coverage.Requirements++
		linked := false
		for _, id := range r.NodeIDs {
			if _, ok := nodeByID[id]; ok {
				linked = true
				linkedNode[id] = true
			}
		}
		if linked {
			f.Coverage.Linked++
		} else {
			sf.Unlinked++
			f.Coverage.Unlinked = append(f.Coverage.Unlinked, UnlinkedRequirement{Spec: r.SpecTitle, Key: r.Key, Text: r.Text, Criticality: r.Criticality})
		}
		if r.Source != "auto" && r.Source != "openapi" {
			written[r.SpecTitle] = append(written[r.SpecTitle], spec.Item{Key: r.Key, Text: r.Text})
		}
	}
	for _, title := range specOrder {
		for _, flags := range spec.QualityOf(written[title]) {
			if len(flags) > 0 {
				specs[title].NeedReview++
			}
		}
		f.Specs = append(f.Specs, *specs[title])
	}
	f.Coverage.PercentRequirements = percent(f.Coverage.Linked, f.Coverage.Requirements)
	sort.SliceStable(f.Coverage.Unlinked, func(i, j int) bool {
		return critRank(f.Coverage.Unlinked[i].Criticality) < critRank(f.Coverage.Unlinked[j].Criticality)
	})
	f.Coverage.UnlinkedTotal = len(f.Coverage.Unlinked)
	f.Coverage.Unlinked = capped(f.Coverage.Unlinked)
	f.Coverage.Screens = len(screens)
	covered := map[string]bool{}
	for _, route := range order {
		for _, n := range screens[route].nodes {
			if linkedNode[n.ID] {
				covered[route] = true
			}
		}
		if !covered[route] {
			f.Coverage.ScreensWithoutRequirement = append(f.Coverage.ScreensWithoutRequirement, route)
		}
	}
	sort.Strings(f.Coverage.ScreensWithoutRequirement)
	f.Coverage.ScreensWithoutRequirementTotal = len(f.Coverage.ScreensWithoutRequirement)
	f.Coverage.ScreensWithoutRequirement = capped(f.Coverage.ScreensWithoutRequirement)
	f.Coverage.ScreensCovered = len(covered)
	f.Coverage.PercentScreens = percent(len(covered), len(screens))

	// ---- capability coverage: screens grouped by route domain ----
	type capAcc struct {
		screens        int
		screensCovered int
		screensTested  int
		status         string
	}
	caps := map[string]*capAcc{}
	for _, route := range order {
		key := capabilityKey(route)
		if caps[key] == nil {
			caps[key] = &capAcc{status: "untested"}
		}
		c := caps[key]
		c.screens++
		if covered[route] {
			c.screensCovered++
		}
		screenStatus := "untested"
		for _, n := range screens[route].nodes {
			screenStatus = worstStatus(screenStatus, in.NodeResults[n.ID])
		}
		if screenStatus != "untested" {
			c.screensTested++
		}
		c.status = worstStatus(c.status, screenStatus)
	}
	keys := make([]string, 0, len(caps))
	for k := range caps {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		c := caps[k]
		f.Capabilities.List = append(f.Capabilities.List, CapabilityItem{
			Key:            k,
			Name:           capabilityName(k),
			Screens:        c.screens,
			ScreensCovered: c.screensCovered,
			ScreensTested:  c.screensTested,
			Status:         c.status,
		})
		if c.screensCovered > 0 {
			f.Capabilities.Covered++
		}
		if c.screensTested > 0 {
			f.Capabilities.Tested++
		}
		if c.status == "fail" || c.status == "error" {
			f.Capabilities.Failing++
		}
	}
	f.Capabilities.Total = len(f.Capabilities.List)
	f.Capabilities.List = capped(f.Capabilities.List)

	// ---- alternative flows: screens not every user reaches ----
	if len(f.Users) > 1 {
		for _, route := range order {
			sc := screens[route]
			var have, missing []string
			for _, u := range f.Users {
				if sc.users[u] {
					have = append(have, u)
				} else {
					missing = append(missing, u)
				}
			}
			if len(missing) > 0 {
				f.Access = append(f.Access, AccessFact{Route: route, Users: have, MissingFor: missing})
			}
		}
		sort.Slice(f.Access, func(i, j int) bool { return f.Access[i].Route < f.Access[j].Route })
	}

	// ---- journeys: screens where something can be done ----
	doing := map[string]bool{}
	for _, e := range in.Edges {
		from, ok := nodeByID[e.FromNodeID]
		to, ok2 := nodeByID[e.ToNodeID]
		if !ok || !ok2 || from.Kind != "page" {
			continue
		}
		var a struct {
			Type string `json:"type"`
		}
		_ = json.Unmarshal(e.Action, &a)
		if a.Type == "request" || a.Type == "submit" || a.Type == "search" || (a.Type == "click" && to.Kind == "modal") {
			doing[from.Label] = true
		}
	}
	for _, route := range order {
		if doing[route] {
			f.Journeys.Routes = append(f.Journeys.Routes, route)
			if !covered[route] {
				f.Journeys.WithoutRequirement = append(f.Journeys.WithoutRequirement, route)
			}
		}
	}
	sort.Strings(f.Journeys.Routes)
	f.Journeys.Count = len(f.Journeys.Routes)
	f.Journeys.Routes = capped(f.Journeys.Routes)
	f.Journeys.WithoutRequirement = capped(f.Journeys.WithoutRequirement)

	// ---- the last regression ----
	if r := in.Regression; r != nil {
		rf := &RegressionFacts{
			FinishedAt: r.FinishedAt, Passed: r.Report.Steps["pass"], Failed: r.Report.Steps["fail"], Errored: r.Report.Steps["error"], Skipped: r.Report.Steps["skipped"],
			Users: r.Report.Users, TestedAs: r.Roles, FailingRequirements: []FailingRequirement{},
			Stale: in.GraphID != uuid.Nil && r.GraphID != uuid.Nil && r.GraphID != in.GraphID,
		}
		if rf.Users == nil {
			rf.Users = []report.UserOutcome{}
		}
		if len(rf.TestedAs) == 0 {
			rf.TestedAs = f.Users
		}
		for _, q := range r.Report.Requirements {
			if q.Outcome != "fail" && q.Outcome != "error" {
				continue
			}
			users := []string{}
			for u, o := range q.ByUser {
				if (o == "fail" || o == "error") && u != "" {
					users = append(users, u)
				}
			}
			sort.Strings(users)
			rf.FailingRequirements = append(rf.FailingRequirements, FailingRequirement{Key: q.Key, Text: q.Text, Criticality: q.Criticality, FailingUsers: users})
		}
		sort.SliceStable(rf.FailingRequirements, func(i, j int) bool {
			return critRank(rf.FailingRequirements[i].Criticality) < critRank(rf.FailingRequirements[j].Criticality)
		})
		rf.FailingRequirements = capped(rf.FailingRequirements)
		f.Regression = rf
	}

	// ---- bugs: what the tests found, and apart from them what the security checks found ----
	for _, b := range in.Bugs {
		security := b.Category == "security"
		switch b.Status {
		case "fixed":
			if security {
				f.Security.Fixed++
			} else {
				f.Bugs.Fixed++
			}
			continue
		case "false_positive":
			continue
		}
		users := b.Users
		if users == nil {
			users = []string{}
		}
		item := BugItem{Title: b.Title, Severity: b.Severity, Status: b.Status, Users: users}
		if security {
			f.Security.Open++
			switch b.Severity {
			case "critical":
				f.Security.Critical++
			case "high":
				f.Security.High++
			default:
				f.Security.Normal++
			}
			f.Security.List = append(f.Security.List, item)
			continue
		}
		f.Bugs.Open++
		switch b.Severity {
		case "critical":
			f.Bugs.Critical++
		case "high":
			f.Bugs.High++
		}
		f.Bugs.List = append(f.Bugs.List, item)
	}
	sort.SliceStable(f.Bugs.List, func(i, j int) bool { return critRank(f.Bugs.List[i].Severity) < critRank(f.Bugs.List[j].Severity) })
	f.Bugs.List = capped(f.Bugs.List)
	sort.SliceStable(f.Security.List, func(i, j int) bool {
		return critRank(f.Security.List[i].Severity) < critRank(f.Security.List[j].Severity)
	})
	f.Security.List = capped(f.Security.List)
	lastSecurityRun(in, &f.Security)
	f.Blocked = blockedBy(in.Latest)
	f.OpenPendencies = in.Pendencies

	f.Issues = issues(f)
	f.Readiness = readiness(in, f)
	return f
}

// blockedBy reads whether the latest run was blocked, from the reason the runner wrote in its summary.
func blockedBy(latest *runInfo) *BlockedFacts {
	if latest == nil || len(latest.Summary) == 0 {
		return nil
	}
	var s struct {
		Blocked *struct {
			Kind    string   `json:"kind"`
			Message string   `json:"message"`
			Roles   []string `json:"roles"`
		} `json:"blocked"`
	}
	if json.Unmarshal(latest.Summary, &s) != nil || s.Blocked == nil || s.Blocked.Message == "" {
		return nil
	}
	return &BlockedFacts{Kind: s.Blocked.Kind, Message: s.Blocked.Message, Roles: s.Blocked.Roles, RunType: latest.Type, At: latest.FinishedAt}
}

// lastSecurityRun fills in what the most recent run that made the security checks said about them. The runner writes it in
// the summary of the run; older runs and runs that turned the checks off have none, and do not erase an earlier one.
func lastSecurityRun(in input, out *SecurityFacts) {
	type seen struct {
		Security *struct {
			Checks int `json:"checks"`
			Failed int `json:"failed"`
			Probes int `json:"probes"`
		} `json:"security"`
	}
	read := func(raw any) *struct {
		Checks int `json:"checks"`
		Failed int `json:"failed"`
		Probes int `json:"probes"`
	} {
		b, err := json.Marshal(raw)
		if err != nil {
			return nil
		}
		var s seen
		if json.Unmarshal(b, &s) != nil {
			return nil
		}
		return s.Security
	}
	var at time.Time
	take := func(when time.Time, raw any) {
		s := read(raw)
		if s == nil || (out.Checked && !when.After(at)) {
			return
		}
		out.Checked, at = true, when
		out.Checks, out.Failed, out.Probes = s.Checks, s.Failed, s.Probes
	}
	if e := in.Exploration; e != nil && len(e.Summary) > 0 {
		take(e.FinishedAt, json.RawMessage(e.Summary))
	}
	if r := in.Regression; r != nil && r.Report.Summary != nil {
		take(r.FinishedAt, r.Report.Summary)
	}
}

func critRank(s string) int {
	switch s {
	case "critical":
		return 0
	case "high":
		return 1
	}
	return 2
}

func plural(n int, one, many string) string {
	if n == 1 {
		return fmt.Sprintf("1 %s", one)
	}
	return fmt.Sprintf("%d %s", n, many)
}

func issues(f Facts) []Issue {
	var out []Issue
	add := func(code, severity, area, message string, items ...string) {
		out = append(out, Issue{Code: code, Severity: severity, Area: area, Message: message, Items: capped(items)})
	}
	if f.Blocked != nil {
		// one problem, said once and first: everything else the run could not do follows from it
		add("environment_blocked", "alta", "execução", f.Blocked.Message)
	}
	if !f.Map.Explored {
		add("no_map", "alta", "mapa", "O ambiente ainda não foi explorado: não há telas para testar nem para comparar com as especificações. Faça uma exploração primeiro.")
		return out
	}
	if f.Blocked == nil && len(f.Map.LoginFailures) > 0 {
		add("login_failed", "alta", "mapa", "Não foi possível entrar com: "+strings.Join(f.Map.LoginFailures, ", ")+". O mapa não inclui o que esses usuários enxergam.", f.Map.LoginFailures...)
	}

	// flows and specifications that do not match
	if n := f.Coverage.UnlinkedTotal; n > 0 {
		severity := "média"
		var keys []string
		for _, u := range f.Coverage.Unlinked {
			keys = append(keys, reqLabel(u.Key, u.Text))
			if u.Criticality == "critical" {
				severity = "alta"
			}
		}
		add("requirements_unlinked", severity, "especificação", plural(n, "requisito não está ligado a nenhuma tela", "requisitos não estão ligados a nenhuma tela")+": não serão testados. Cruze a especificação com o mapa ou responda as pendências.", keys...)
	}
	if n := f.Coverage.ScreensWithoutRequirementTotal; n > 0 {
		severity := "baixa"
		if f.Coverage.Screens > 0 && n*2 > f.Coverage.Screens {
			severity = "média"
		}
		add("screens_without_requirement", severity, "especificação", plural(n, "tela existe na aplicação e nenhum requisito fala dela", "telas existem na aplicação e nenhum requisito fala delas")+". A especificação pode estar incompleta.", f.Coverage.ScreensWithoutRequirement...)
	}
	if n := len(f.Journeys.WithoutRequirement); n > 0 {
		add("journeys_without_requirement", "média", "fluxo", plural(n, "tela com ações (formulário, janela, busca ou chamada de API) não tem requisito", "telas com ações (formulário, janela, busca ou chamada de API) não têm requisito")+": o que ela faz não está especificado.", f.Journeys.WithoutRequirement...)
	}
	review := 0
	for _, s := range f.Specs {
		review += s.NeedReview
	}
	if review > 0 {
		add("requirement_quality", "baixa", "especificação", plural(review, "requisito pode ser difícil de testar", "requisitos podem ser difíceis de testar")+" (vagos, curtos, compostos ou repetidos). Revise na página de Especificações.")
	}
	if len(f.Users) > 1 && len(f.Access) > 0 {
		var routes []string
		for _, a := range f.Access {
			routes = append(routes, a.Route+" (não alcançada por "+strings.Join(a.MissingFor, ", ")+")")
		}
		add("alternative_flows", "baixa", "fluxo", plural(len(f.Access), "tela é alcançada só por alguns usuários", "telas são alcançadas só por alguns usuários")+": são os fluxos alternativos. Confira se cada um tem requisito próprio.", routes...)
	}
	if len(f.Users) == 1 {
		add("single_user", "baixa", "fluxo", "Só um usuário foi explorado ("+f.Users[0]+"): não dá para comparar permissões nem achar fluxos alternativos. Cadastre outro usuário em Credenciais.")
	}

	// results
	if f.Regression == nil {
		add("no_regression", "média", "execução", "Nenhuma regressão foi executada: o que está mapeado ainda não foi testado.")
	} else {
		r := f.Regression
		if r.Stale {
			add("regression_stale", "média", "execução", "A última regressão testou uma versão antiga do mapa. Rode outra para refletir o que foi explorado depois.")
		}
		var crit, other []string
		for _, q := range r.FailingRequirements {
			line := reqLabel(q.Key, q.Text)
			if len(q.FailingUsers) > 0 {
				line += " (falha para " + strings.Join(q.FailingUsers, ", ") + ")"
			}
			if q.Criticality == "critical" {
				crit = append(crit, line)
			} else {
				other = append(other, line)
			}
		}
		if len(crit) > 0 {
			add("failing_critical", "alta", "execução", plural(len(crit), "requisito crítico falhou", "requisitos críticos falharam")+" na última regressão.", crit...)
		}
		if len(other) > 0 {
			add("failing_requirements", "média", "execução", plural(len(other), "requisito falhou", "requisitos falharam")+" na última regressão.", other...)
		}
	}
	if f.Bugs.Critical > 0 {
		add("open_critical_bugs", "alta", "bug", plural(f.Bugs.Critical, "bug crítico está aberto", "bugs críticos estão abertos")+".")
	}
	if f.Bugs.High > 0 {
		add("open_high_bugs", "média", "bug", plural(f.Bugs.High, "bug de gravidade alta está aberto", "bugs de gravidade alta estão abertos")+".")
	}
	if f.Security.Critical > 0 {
		add("security_critical", "alta", "segurança", plural(f.Security.Critical, "falha de segurança crítica está aberta", "falhas de segurança críticas estão abertas")+".", securityTitles(f.Security, "critical")...)
	}
	if f.Security.High > 0 {
		add("security_high", "média", "segurança", plural(f.Security.High, "falha de segurança de gravidade alta está aberta", "falhas de segurança de gravidade alta estão abertas")+".", securityTitles(f.Security, "high")...)
	}
	if !f.Security.Checked && f.Security.Open == 0 {
		add("security_unchecked", "baixa", "segurança", "As verificações de segurança (cabeçalhos, cookies, CSRF, XSS, SQL injection...) ainda não rodaram neste ambiente. Elas fazem parte de toda exploração e regressão.")
	}
	if f.OpenPendencies > 0 {
		add("open_pendencies", "baixa", "especificação", plural(f.OpenPendencies, "pendência espera resposta", "pendências esperam resposta")+": enquanto isso o requisito fica sem tela.")
	}

	rank := map[string]int{"alta": 0, "média": 1, "baixa": 2}
	sort.SliceStable(out, func(i, j int) bool { return rank[out[i].Severity] < rank[out[j].Severity] })
	return out
}

func securityTitles(s SecurityFacts, severity string) []string {
	var out []string
	for _, b := range s.List {
		if b.Severity == severity {
			out = append(out, strings.TrimPrefix(b.Title, "Segurança · "))
		}
	}
	return out
}

func shorten(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if r := []rune(s); len(r) > n {
		return string(r[:n]) + "…"
	}
	return s
}

func capabilityKey(route string) string {
	route = strings.TrimSpace(route)
	if route == "" || route == "/" {
		return "home"
	}
	route = strings.TrimPrefix(route, "/")
	if route == "" {
		return "home"
	}
	seg := strings.Split(route, "/")[0]
	if seg == "" {
		return "home"
	}
	return strings.ToLower(seg)
}

func capabilityName(key string) string {
	if key == "home" {
		return "Entrada e navegação"
	}
	return strings.ToUpper(key[:1]) + key[1:]
}

func statusRank(s string) int {
	switch s {
	case "fail":
		return 5
	case "error":
		return 4
	case "pass":
		return 3
	case "skipped":
		return 2
	default:
		return 1
	}
}

func worstStatus(a, b string) string {
	if statusRank(b) > statusRank(a) {
		if b == "" {
			return a
		}
		return b
	}
	if a == "" {
		return "untested"
	}
	return a
}

func accessCheck(f Facts) Check {
	switch {
	case f.Blocked == nil:
		return Check{ID: "access", Label: "Aplicação no ar e login funcionando", OK: true, Detail: "A última execução conseguiu abrir a aplicação e entrar."}
	case f.Blocked.Kind == "app_down":
		return Check{ID: "access", Label: "Aplicação no ar e login funcionando", OK: false, Detail: "A aplicação estava fora do ar na última execução: " + f.Blocked.Message}
	default:
		return Check{ID: "access", Label: "Aplicação no ar e login funcionando", OK: false, Detail: "O login não funcionou na última execução: " + f.Blocked.Message}
	}
}

func readiness(in input, f Facts) []Check {
	check := func(id, label string, ok bool, yes, no string) Check {
		d := no
		if ok {
			d = yes
		}
		return Check{ID: id, Label: label, OK: ok, Detail: d}
	}
	return []Check{
		accessCheck(f),
		check("runner", "Runner conectado", in.Runners > 0, "Há um runner ativo.", "Nenhum runner respondeu nos últimos 2 minutos: as execuções ficam na fila."),
		check("llm", "Modelo de IA configurado", in.LLM, "A extração de requisitos, o cruzamento e o resumo do relatório podem usar IA.", "Sem modelo de IA: a extração e o cruzamento não funcionam, e o relatório usa o texto padrão."),
		check("storage", "Armazenamento de evidências", in.Storage, "Capturas, miniaturas e evidências são guardadas.", "Sem armazenamento: não há capturas, miniaturas nem evidências."),
		check("users", "Usuários cadastrados", len(f.Users) > 0, plural(len(f.Users), "usuário explorado", "usuários explorados")+".", "Nenhum usuário entrou: só telas públicas são vistas."),
		check("map", "Aplicação mapeada", f.Map.Explored, plural(f.Map.Screens, "tela mapeada", "telas mapeadas")+".", "Ainda não há mapa: faça uma exploração."),
		check("spec", "Especificação cruzada com o mapa", f.Coverage.Linked > 0, plural(f.Coverage.Linked, "requisito ligado a telas", "requisitos ligados a telas")+".", "Nenhum requisito está ligado a uma tela."),
		check("regression", "Regressão executada", f.Regression != nil, "Há uma regressão com resultados.", "Nenhuma regressão foi executada."),
	}
}
