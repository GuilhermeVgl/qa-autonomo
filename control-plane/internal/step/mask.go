// Package step records the steps a run executed (input, expected, actual, result) and their evidence.
package step

import (
	"encoding/json"
	"regexp"
)

var secretKey = regexp.MustCompile(`(?i)(pass(word)?|secret|token|authorization|api[_-]?key|cookie|credential)`)

// MaskInput hides secret-looking values in a step input before it is stored (CLAUDE.md, seção 12).
// Matching is by key name; anything that is not valid JSON becomes {}.
func MaskInput(raw json.RawMessage) json.RawMessage {
	var v any
	if len(raw) == 0 || json.Unmarshal(raw, &v) != nil {
		return json.RawMessage(`{}`)
	}
	out, err := json.Marshal(mask(v))
	if err != nil {
		return json.RawMessage(`{}`)
	}
	return out
}

func mask(v any) any {
	switch t := v.(type) {
	case map[string]any:
		for k, val := range t {
			if secretKey.MatchString(k) {
				t[k] = "***"
			} else {
				t[k] = mask(val)
			}
		}
		return t
	case []any:
		for i := range t {
			t[i] = mask(t[i])
		}
		return t
	default:
		return v
	}
}
