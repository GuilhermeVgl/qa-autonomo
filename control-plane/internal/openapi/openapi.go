// Package openapi turns an OpenAPI 3.x document into testable operations (CLAUDE.md, seção 8.1): a deterministic
// parser, no LLM. Only local $refs are followed, so a spec can never make the server fetch anything.
package openapi

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

const (
	MaxBytes      = 2 << 20 // 2 MiB
	maxRefDepth   = 8       // nested $ref expansion; deeper (or cyclic) references are cut
	maxOperations = 2000
)

type Param struct {
	Name     string `json:"name"`
	In       string `json:"in"` // path | query
	Required bool   `json:"required"`
	Example  string `json:"example"`
}

type Operation struct {
	Method     string         `json:"method"`
	Path       string         `json:"path"`
	Summary    string         `json:"summary"`
	Status     int            `json:"status"`           // primary documented 2xx
	Schema     map[string]any `json:"schema,omitempty"` // JSON Schema of the response body, $refs resolved
	PathParams []Param        `json:"path_params,omitempty"`
	Query      []Param        `json:"query,omitempty"` // required query parameters only
	BodyNeeded bool           `json:"body_required,omitempty"`
}

type Doc struct {
	Title      string
	Version    string
	Operations []Operation
	Skipped    []string // operations with no documented 2xx
}

// Key is the stable identity of an operation, also its fingerprint as a graph node (seção 9): method + path template.
func (o Operation) Key() string { return o.Method + " " + o.Path }

// Criticality: mutating operations matter more than reads.
func (o Operation) Criticality() string {
	switch o.Method {
	case "POST", "PUT", "PATCH", "DELETE":
		return "high"
	default:
		return "normal"
	}
}

// RequirementText states the contract; it embeds a hash of the schema so contract changes mark the requirement as changed.
func (o Operation) RequirementText() string {
	body := "sem corpo"
	if o.Schema != nil {
		b, _ := json.Marshal(o.Schema)
		sum := sha256.Sum256(b)
		body = "corpo conforme o schema (contrato " + hex.EncodeToString(sum[:])[:8] + ")"
	}
	return fmt.Sprintf("%s responde %d com %s", o.Key(), o.Status, body)
}

// ConcretePath substitutes path parameters with their examples.
func (o Operation) ConcretePath() string {
	p := o.Path
	for _, pp := range o.PathParams {
		p = strings.ReplaceAll(p, "{"+pp.Name+"}", pp.Example)
	}
	return p
}

var methods = []string{"get", "put", "post", "delete", "patch", "head"}

// Parse accepts OpenAPI 3.x as JSON or YAML.
func Parse(data []byte) (Doc, error) {
	if len(data) > MaxBytes {
		return Doc{}, fmt.Errorf("spec exceeds %d bytes", MaxBytes)
	}
	var root map[string]any
	if err := yaml.Unmarshal(data, &root); err != nil || root == nil {
		return Doc{}, errors.New("not a valid OpenAPI document (expected JSON or YAML)")
	}
	version, _ := root["openapi"].(string)
	if !strings.HasPrefix(version, "3.") {
		return Doc{}, errors.New("only OpenAPI 3.x is supported")
	}
	paths, _ := root["paths"].(map[string]any)
	if len(paths) == 0 {
		return Doc{}, errors.New("the document has no paths")
	}
	info, _ := root["info"].(map[string]any)
	doc := Doc{Title: str(info["title"]), Version: str(info["version"])}
	r := &resolver{root: root}

	pathKeys := make([]string, 0, len(paths))
	for p := range paths {
		pathKeys = append(pathKeys, p)
	}
	sort.Strings(pathKeys)
	for _, path := range pathKeys {
		item, _ := paths[path].(map[string]any)
		shared := r.params(item["parameters"])
		for _, m := range methods {
			opRaw, ok := item[m].(map[string]any)
			if !ok {
				continue
			}
			op := Operation{Method: strings.ToUpper(m), Path: path, Summary: str(opRaw["summary"])}
			status, schemaRaw, found := primarySuccess(r, opRaw["responses"])
			if !found {
				doc.Skipped = append(doc.Skipped, op.Key())
				continue
			}
			op.Status = status
			if schemaRaw != nil {
				s, err := r.schema(schemaRaw, 0)
				if err != nil {
					return Doc{}, fmt.Errorf("%s: %w", op.Key(), err)
				}
				op.Schema = s
			}
			for _, p := range mergeParams(shared, r.params(opRaw["parameters"])) {
				switch p.In {
				case "path":
					op.PathParams = append(op.PathParams, p)
				case "query":
					if p.Required {
						op.Query = append(op.Query, p)
					}
				}
			}
			if rb, _ := r.deref(opRaw["requestBody"]).(map[string]any); rb != nil {
				op.BodyNeeded, _ = rb["required"].(bool)
			}
			if r.err != nil {
				return Doc{}, fmt.Errorf("%s: %w", op.Key(), r.err)
			}
			doc.Operations = append(doc.Operations, op)
			if len(doc.Operations) > maxOperations {
				return Doc{}, fmt.Errorf("more than %d operations", maxOperations)
			}
		}
	}
	if len(doc.Operations) == 0 {
		return Doc{}, errors.New("the document has no testable operations")
	}
	return doc, nil
}

// primarySuccess picks the lowest documented 2xx and the JSON schema of its body, if any.
func primarySuccess(r *resolver, responses any) (int, any, bool) {
	m, _ := responses.(map[string]any)
	best := 0
	var bestResp map[string]any
	for code, v := range m {
		n, err := strconv.Atoi(code)
		if err != nil || n < 200 || n > 299 {
			continue
		}
		if best == 0 || n < best {
			best = n
			bestResp, _ = r.deref(v).(map[string]any)
		}
	}
	if best == 0 {
		return 0, nil, false
	}
	content, _ := bestResp["content"].(map[string]any)
	for _, mt := range []string{"application/json"} {
		if media, ok := content[mt].(map[string]any); ok {
			return best, media["schema"], true
		}
	}
	return best, nil, true
}

func mergeParams(shared, own []Param) []Param {
	out := append([]Param{}, shared...)
	for _, p := range own {
		replaced := false
		for i, s := range out {
			if s.Name == p.Name && s.In == p.In {
				out[i], replaced = p, true
			}
		}
		if !replaced {
			out = append(out, p)
		}
	}
	return out
}

type resolver struct {
	root map[string]any
	err  error
}

// deref follows a local "#/..." reference once; anything else is an error recorded on the resolver.
func (r *resolver) deref(v any) any {
	m, ok := v.(map[string]any)
	if !ok {
		return v
	}
	ref, ok := m["$ref"].(string)
	if !ok {
		return v
	}
	if !strings.HasPrefix(ref, "#/") {
		r.err = fmt.Errorf("only local references are supported, got %q", ref)
		return nil
	}
	var cur any = r.root
	for _, part := range strings.Split(ref[2:], "/") {
		part = strings.NewReplacer("~1", "/", "~0", "~").Replace(part)
		next, ok := cur.(map[string]any)
		if !ok {
			r.err = fmt.Errorf("unresolved reference %q", ref)
			return nil
		}
		cur, ok = next[part]
		if !ok {
			r.err = fmt.Errorf("unresolved reference %q", ref)
			return nil
		}
	}
	return cur
}

func (r *resolver) params(v any) []Param {
	list, _ := v.([]any)
	var out []Param
	for _, raw := range list {
		m, _ := r.deref(raw).(map[string]any)
		if m == nil {
			continue
		}
		p := Param{Name: str(m["name"]), In: str(m["in"])}
		p.Required, _ = m["required"].(bool)
		schema, _ := r.deref(m["schema"]).(map[string]any)
		p.Example = example(m, schema)
		out = append(out, p)
	}
	return out
}

// example prefers an explicit example, then a type-based placeholder.
func example(param, schema map[string]any) string {
	if v, ok := param["example"]; ok {
		return fmt.Sprint(v)
	}
	if v, ok := schema["example"]; ok {
		return fmt.Sprint(v)
	}
	if v, ok := schema["default"]; ok {
		return fmt.Sprint(v)
	}
	if enum, ok := schema["enum"].([]any); ok && len(enum) > 0 {
		return fmt.Sprint(enum[0])
	}
	switch str(schema["type"]) {
	case "integer", "number":
		return "1"
	case "boolean":
		return "true"
	}
	if str(schema["format"]) == "uuid" {
		return "00000000-0000-4000-8000-000000000001"
	}
	return "1"
}

// schema resolves $refs inline (cutting cycles and excessive depth) and rewrites the OpenAPI-only `nullable`.
func (r *resolver) schema(v any, depth int) (map[string]any, error) {
	if depth > maxRefDepth {
		return map[string]any{}, nil // unconstrained: better than an infinite expansion
	}
	m, ok := v.(map[string]any)
	if !ok {
		return nil, nil
	}
	if _, isRef := m["$ref"]; isRef {
		target := r.deref(m)
		if r.err != nil {
			return nil, r.err
		}
		return r.schema(target, depth+1)
	}
	out := make(map[string]any, len(m))
	for k, val := range m {
		switch k {
		case "properties":
			props, _ := val.(map[string]any)
			np := make(map[string]any, len(props))
			for pk, pv := range props {
				s, err := r.schema(pv, depth+1)
				if err != nil {
					return nil, err
				}
				np[pk] = s
			}
			out[k] = np
		case "items", "additionalProperties":
			if s, err := r.schema(val, depth+1); err != nil {
				return nil, err
			} else if s != nil {
				out[k] = s
			} else {
				out[k] = val
			}
		case "allOf", "anyOf", "oneOf":
			list, _ := val.([]any)
			nl := make([]any, 0, len(list))
			for _, e := range list {
				s, err := r.schema(e, depth+1)
				if err != nil {
					return nil, err
				}
				nl = append(nl, s)
			}
			out[k] = nl
		case "nullable":
			// handled below
		default:
			out[k] = val
		}
	}
	if nullable, _ := m["nullable"].(bool); nullable {
		switch t := out["type"].(type) {
		case string:
			out["type"] = []any{t, "null"}
		}
	}
	return out, nil
}

func str(v any) string {
	s, _ := v.(string)
	return s
}
