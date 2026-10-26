// Package events implements the event stream every operation reports through
// (docs/design/spec/events-v1.md): an envelope, an emitter that numbers and masks events,
// and sinks that write or collect them.
package events

import (
	"encoding/json"
	"io"
	"sort"
	"strings"
	"sync"
	"time"
)

// Levels.
const (
	Debug = "debug"
	Info  = "info"
	Warn  = "warn"
	Error = "error"
)

// Event is one line of the stream.
type Event struct {
	V     int             `json:"v"`
	TS    time.Time       `json:"ts"`
	Run   string          `json:"run,omitempty"`
	Seq   int64           `json:"seq"`
	Type  string          `json:"type"`
	Level string          `json:"level"`
	Msg   string          `json:"msg"`
	Data  json.RawMessage `json:"data,omitempty"`
}

// Sink receives events.
type Sink interface {
	Emit(Event)
}

// SinkFunc adapts a function to a Sink.
type SinkFunc func(Event)

// Emit calls f.
func (f SinkFunc) Emit(e Event) { f(e) }

// Emitter numbers events, masks secrets in them and hands them to a sink. It is safe for
// concurrent use.
type Emitter struct {
	mu     sync.Mutex
	run    string
	seq    int64
	sink   Sink
	masker *Masker
	now    func() time.Time
}

// NewEmitter returns an emitter for a run. masker may be nil.
func NewEmitter(run string, sink Sink, masker *Masker) *Emitter {
	if masker == nil {
		masker = NewMasker()
	}
	return &Emitter{run: run, sink: sink, masker: masker, now: time.Now}
}

// Masker returns the emitter's masker, so values learnt during a run can be added to it.
func (e *Emitter) Masker() *Masker { return e.masker }

// Emit sends an event of the given type and level. data is any JSON-serialisable value.
func (e *Emitter) Emit(level, typ, msg string, data any) {
	var raw json.RawMessage
	if data != nil {
		b, err := json.Marshal(data)
		if err == nil {
			raw = json.RawMessage(e.masker.Mask(string(b)))
		}
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	e.seq++
	e.sink.Emit(Event{
		V: 1, TS: e.now().UTC(), Run: e.run, Seq: e.seq,
		Type: typ, Level: level, Msg: e.masker.Mask(msg), Data: raw,
	})
}

// Info emits an info event.
func (e *Emitter) Info(typ, msg string, data any) { e.Emit(Info, typ, msg, data) }

// Warn emits a warning event.
func (e *Emitter) Warn(typ, msg string, data any) { e.Emit(Warn, typ, msg, data) }

// Debug emits a debug event.
func (e *Emitter) Debug(typ, msg string, data any) { e.Emit(Debug, typ, msg, data) }

// Errorf emits an error event.
func (e *Emitter) Errorf(typ, msg string, data any) { e.Emit(Error, typ, msg, data) }

// Forward re-emits an event received from another stream (the agent's), keeping its type,
// level, message and data but numbering it in this stream.
func (e *Emitter) Forward(ev Event) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.seq++
	ev.Seq = e.seq
	ev.Msg = e.masker.Mask(ev.Msg)
	if ev.Data != nil {
		ev.Data = json.RawMessage(e.masker.Mask(string(ev.Data)))
	}
	if ev.Run == "" {
		ev.Run = e.run
	}
	e.sink.Emit(ev)
}

// Masker replaces secret values with *** in text.
type Masker struct {
	mu     sync.RWMutex
	values []string
}

// NewMasker returns a masker for the given values.
func NewMasker(values ...string) *Masker {
	m := &Masker{}
	m.Add(values...)
	return m
}

// minMasked is the shortest value masked: shorter ones would mask ordinary words.
const minMasked = 4

// Add adds values to mask. Values shorter than 4 characters are ignored.
func (m *Masker) Add(values ...string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, v := range values {
		if len(v) < minMasked {
			continue
		}
		m.values = append(m.values, v)
		// the JSON-escaped form too, since events carry data as JSON
		if b, err := json.Marshal(v); err == nil {
			if esc := string(b[1 : len(b)-1]); esc != v {
				m.values = append(m.values, esc)
			}
		}
	}
	// longest first, so a value containing another is masked whole
	sort.Slice(m.values, func(i, j int) bool { return len(m.values[i]) > len(m.values[j]) })
}

// Mask returns s with every known value replaced by ***.
func (m *Masker) Mask(s string) string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, v := range m.values {
		if strings.Contains(s, v) {
			s = strings.ReplaceAll(s, v, "***")
		}
	}
	return s
}

// JSONSink writes events as JSON Lines.
type JSONSink struct {
	mu sync.Mutex
	w  io.Writer
}

// NewJSONSink returns a sink writing to w.
func NewJSONSink(w io.Writer) *JSONSink { return &JSONSink{w: w} }

// Emit writes one line.
func (s *JSONSink) Emit(e Event) {
	b, err := json.Marshal(e)
	if err != nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_, _ = s.w.Write(append(b, '\n'))
}

// Collector keeps events in memory, for tests.
type Collector struct {
	mu     sync.Mutex
	Events []Event
}

// Emit stores the event.
func (c *Collector) Emit(e Event) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.Events = append(c.Events, e)
}

// Types returns the types of the collected events, in order.
func (c *Collector) Types() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]string, len(c.Events))
	for i, e := range c.Events {
		out[i] = e.Type
	}
	return out
}

// Multi sends every event to several sinks.
type Multi []Sink

// Emit forwards e to every sink.
func (m Multi) Emit(e Event) {
	for _, s := range m {
		s.Emit(e)
	}
}
