package llm

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
)

// ErrInvalidOutput marks a model reply that could not be used even after asking again.
var ErrInvalidOutput = errors.New("invalid LLM output")

// Completer is the part of the gateway that callers need.
type Completer interface {
	Complete(ctx context.Context, orgID uuid.UUID, task string, msgs []Message, jsonMode bool) (string, error)
}

// CompleteParsed asks for JSON and parses it with parse. Small and local models get the format wrong now and then,
// so when the first reply is invalid the model is shown what was wrong and asked once more; after a second invalid
// reply the error wraps ErrInvalidOutput. Provider failures are returned as they are and are not retried.
func CompleteParsed[T any](ctx context.Context, c Completer, orgID uuid.UUID, task string, msgs []Message, parse func(string) (T, error)) (T, error) {
	var zero T
	out, err := c.Complete(ctx, orgID, task, msgs, true)
	if err != nil {
		return zero, err
	}
	v, perr := parse(out)
	if perr == nil {
		return v, nil
	}

	again := append(append([]Message{}, msgs...),
		Message{Role: "assistant", Content: out},
		Message{Role: "user", Content: "Sua resposta anterior não pôde ser usada: " + perr.Error() +
			". Responda de novo SOMENTE com o JSON no formato pedido, sem texto antes ou depois e sem cercas de código."})
	out, err = c.Complete(ctx, orgID, task, again, true)
	if err != nil {
		return zero, err
	}
	v, perr = parse(out)
	if perr != nil {
		return zero, fmt.Errorf("%w: %v", ErrInvalidOutput, perr)
	}
	return v, nil
}
