package openapi

import (
	"strings"
	"testing"
)

const sample = `
openapi: 3.0.3
info: { title: Pedidos API, version: "1.2.0" }
paths:
  /orders:
    get:
      summary: Lista pedidos
      parameters:
        - { name: page, in: query, required: false, schema: { type: integer } }
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                type: array
                items: { $ref: "#/components/schemas/Order" }
        "401": { description: no auth }
    post:
      summary: Cria pedido
      requestBody: { required: true, content: { application/json: { schema: { $ref: "#/components/schemas/NewOrder" } } } }
      responses:
        "201":
          description: criado
          content: { application/json: { schema: { $ref: "#/components/schemas/Order" } } }
  /orders/{id}:
    parameters:
      - { name: id, in: path, required: true, schema: { type: integer, example: 42 } }
    get:
      responses:
        "200": { description: ok, content: { application/json: { schema: { $ref: "#/components/schemas/Order" } } } }
        "404": { description: nope }
    delete:
      responses:
        "204": { description: apagado }
  /health:
    get:
      responses:
        default: { description: whatever }
  /customers/{uuid}:
    get:
      parameters:
        - { name: uuid, in: path, required: true, schema: { type: string, format: uuid } }
      responses:
        "200": { description: ok, content: { application/json: { schema: { type: object, properties: { name: { type: string, nullable: true } } } } } }
components:
  schemas:
    Order:
      type: object
      required: [id, total]
      properties:
        id: { type: integer }
        total: { type: number }
        customer: { $ref: "#/components/schemas/Customer" }
    Customer:
      type: object
      properties:
        name: { type: string }
        parent: { $ref: "#/components/schemas/Customer" }
    NewOrder:
      type: object
      properties: { total: { type: number } }
`

func TestParse_OperationsWithPrimaryStatusAndResolvedSchemas(t *testing.T) {
	doc, err := Parse([]byte(sample))
	if err != nil {
		t.Fatal(err)
	}
	if doc.Title != "Pedidos API" || doc.Version != "1.2.0" {
		t.Errorf("doc = %q %q", doc.Title, doc.Version)
	}
	byKey := map[string]Operation{}
	for _, op := range doc.Operations {
		byKey[op.Key()] = op
	}
	for _, key := range []string{"GET /orders", "POST /orders", "GET /orders/{id}", "DELETE /orders/{id}", "GET /customers/{uuid}"} {
		if _, ok := byKey[key]; !ok {
			t.Errorf("missing operation %q (have %v)", key, keys(byKey))
		}
	}
	if _, ok := byKey["GET /health"]; ok {
		t.Error("an operation with no documented 2xx cannot be tested for a status and must be skipped")
	}
	if len(doc.Skipped) != 1 || doc.Skipped[0] != "GET /health" {
		t.Errorf("skipped = %v", doc.Skipped)
	}

	if byKey["POST /orders"].Status != 201 || byKey["DELETE /orders/{id}"].Status != 204 || byKey["GET /orders"].Status != 200 {
		t.Error("primary status must be the documented 2xx")
	}
	list := byKey["GET /orders"].Schema
	if list["type"] != "array" {
		t.Fatalf("list schema = %v", list)
	}
	item, _ := list["items"].(map[string]any)
	if item["type"] != "object" || item["required"] == nil {
		t.Errorf("$ref was not resolved: %v", item)
	}
	if byKey["DELETE /orders/{id}"].Schema != nil {
		t.Error("204 has no body schema")
	}
}

func TestParse_PathParamsGetUsableExamples(t *testing.T) {
	doc, _ := Parse([]byte(sample))
	var byID, byUUID Operation
	for _, op := range doc.Operations {
		switch op.Key() {
		case "GET /orders/{id}":
			byID = op
		case "GET /customers/{uuid}":
			byUUID = op
		}
	}
	if len(byID.PathParams) != 1 || byID.PathParams[0].Example != "42" {
		t.Errorf("explicit example must win: %+v", byID.PathParams)
	}
	if len(byUUID.PathParams) != 1 || !strings.Contains(byUUID.PathParams[0].Example, "-") {
		t.Errorf("uuid placeholder = %+v", byUUID.PathParams)
	}
	if got := byID.ConcretePath(); got != "/orders/42" {
		t.Errorf("ConcretePath = %q", got)
	}
}

func TestParse_RecursiveSchemasTerminate(t *testing.T) {
	doc, err := Parse([]byte(sample))
	if err != nil {
		t.Fatal(err)
	}
	for _, op := range doc.Operations {
		if op.Key() == "GET /orders" {
			// Customer.parent -> Customer is a cycle: it must be cut, not expanded forever
			if depth(op.Schema) > 12 {
				t.Errorf("schema depth %d: cycle not cut", depth(op.Schema))
			}
		}
	}
}

func TestParse_NullableBecomesATypeUnion(t *testing.T) {
	doc, _ := Parse([]byte(sample))
	for _, op := range doc.Operations {
		if op.Key() == "GET /customers/{uuid}" {
			name := op.Schema["properties"].(map[string]any)["name"].(map[string]any)
			types, ok := name["type"].([]any)
			if !ok || len(types) != 2 {
				t.Errorf("nullable string should be [string, null], got %v", name["type"])
			}
			if _, still := name["nullable"]; still {
				t.Error("OpenAPI-only `nullable` keyword must not leak into the JSON Schema")
			}
		}
	}
}

func TestOperation_RequirementText(t *testing.T) {
	doc, _ := Parse([]byte(sample))
	var op Operation
	for _, o := range doc.Operations {
		if o.Key() == "POST /orders" {
			op = o
		}
	}
	if op.Criticality() != "high" {
		t.Errorf("mutating operations are high criticality, got %s", op.Criticality())
	}
	text := op.RequirementText()
	if !strings.Contains(text, "POST /orders") || !strings.Contains(text, "201") {
		t.Errorf("text = %q", text)
	}
	// the text changes when the contract changes, so a new spec version marks the requirement as changed
	changed := strings.Replace(sample, "total: { type: number }\n        customer", "total: { type: string }\n        customer", 1)
	doc2, _ := Parse([]byte(changed))
	for _, o := range doc2.Operations {
		if o.Key() == "POST /orders" && o.RequirementText() == text {
			t.Error("a schema change must change the requirement text")
		}
	}
	if (Operation{Method: "GET", Path: "/x", Status: 200}).Criticality() != "normal" {
		t.Error("GET is normal")
	}
}

func TestParse_Rejections(t *testing.T) {
	cases := map[string]string{
		"not yaml/json": "{{{{",
		"swagger 2":     "swagger: '2.0'\ninfo: {title: x, version: '1'}\npaths: {}",
		"no paths":      "openapi: 3.0.0\ninfo: {title: x, version: '1'}",
		"no operations": "openapi: 3.0.0\ninfo: {title: x, version: '1'}\npaths: {}",
		"remote $ref":   "openapi: 3.0.0\ninfo: {title: x, version: '1'}\npaths:\n  /a:\n    get:\n      responses:\n        '200': {description: ok, content: {application/json: {schema: {$ref: 'http://evil.example/s.json'}}}}",
		"file $ref":     "openapi: 3.0.0\ninfo: {title: x, version: '1'}\npaths:\n  /a:\n    get:\n      responses:\n        '200': {description: ok, content: {application/json: {schema: {$ref: '/etc/passwd'}}}}",
		"dangling $ref": "openapi: 3.0.0\ninfo: {title: x, version: '1'}\npaths:\n  /a:\n    get:\n      responses:\n        '200': {description: ok, content: {application/json: {schema: {$ref: '#/components/schemas/Nope'}}}}",
		"too big":       "openapi: 3.0.0\n# " + strings.Repeat("x", MaxBytes) + "\npaths: {}",
	}
	for name, in := range cases {
		if _, err := Parse([]byte(in)); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
}

func TestParse_JSONInputWorksToo(t *testing.T) {
	doc, err := Parse([]byte(`{"openapi":"3.0.1","info":{"title":"J","version":"1"},"paths":{"/ping":{"get":{"responses":{"200":{"description":"ok"}}}}}}`))
	if err != nil || len(doc.Operations) != 1 || doc.Operations[0].Key() != "GET /ping" {
		t.Fatalf("%+v, %v", doc, err)
	}
}

func keys(m map[string]Operation) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	return out
}

func depth(v any) int {
	switch t := v.(type) {
	case map[string]any:
		d := 0
		for _, c := range t {
			if x := depth(c); x > d {
				d = x
			}
		}
		return d + 1
	case []any:
		d := 0
		for _, c := range t {
			if x := depth(c); x > d {
				d = x
			}
		}
		return d + 1
	}
	return 0
}
