package llm

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"
)

type seqCompleter struct {
	replies []string
	calls   [][]Message
	err     error
}

func (s *seqCompleter) Complete(_ context.Context, _ uuid.UUID, _ string, msgs []Message, _ bool) (string, error) {
	s.calls = append(s.calls, msgs)
	if s.err != nil {
		return "", s.err
	}
	r := s.replies[min(len(s.calls)-1, len(s.replies)-1)]
	return r, nil
}

func parseOK(out string) (string, error) {
	if out != "good" {
		return "", errors.New("not good")
	}
	return out, nil
}

func TestCompleteParsed_ValidFirstTimeCallsOnce(t *testing.T) {
	c := &seqCompleter{replies: []string{"good"}}
	got, err := CompleteParsed(context.Background(), c, uuid.New(), "t", []Message{{Role: "user", Content: "q"}}, parseOK)
	if err != nil || got != "good" || len(c.calls) != 1 {
		t.Fatalf("got=%q err=%v calls=%d", got, err, len(c.calls))
	}
}

func TestCompleteParsed_AsksOnceMoreAndTellsTheModelWhatWasWrong(t *testing.T) {
	c := &seqCompleter{replies: []string{"bad", "good"}}
	got, err := CompleteParsed(context.Background(), c, uuid.New(), "t", []Message{{Role: "user", Content: "q"}}, parseOK)
	if err != nil || got != "good" || len(c.calls) != 2 {
		t.Fatalf("got=%q err=%v calls=%d", got, err, len(c.calls))
	}
	retry := c.calls[1]
	if len(retry) != 3 || retry[1].Role != "assistant" || retry[1].Content != "bad" || !strings.Contains(retry[2].Content, "not good") {
		t.Errorf("retry conversation = %+v", retry)
	}
	if len(c.calls[0]) != 1 {
		t.Error("the first call must not be changed by the retry")
	}
}

func TestCompleteParsed_GivesUpAfterTheSecondInvalidReply(t *testing.T) {
	c := &seqCompleter{replies: []string{"bad", "still bad"}}
	_, err := CompleteParsed(context.Background(), c, uuid.New(), "t", nil, parseOK)
	if !errors.Is(err, ErrInvalidOutput) || len(c.calls) != 2 {
		t.Fatalf("err=%v calls=%d", err, len(c.calls))
	}
}

func TestCompleteParsed_ProviderErrorsAreNotRetriedNorMistakenForBadOutput(t *testing.T) {
	boom := errors.New("provider down")
	c := &seqCompleter{err: boom}
	_, err := CompleteParsed(context.Background(), c, uuid.New(), "t", nil, parseOK)
	if !errors.Is(err, boom) || errors.Is(err, ErrInvalidOutput) || len(c.calls) != 1 {
		t.Fatalf("err=%v calls=%d", err, len(c.calls))
	}
}
