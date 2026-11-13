// The Go example harness (stage0/src/lang/go.ts). go.ts writes it into the staged package as zz_openarc_test.go, with the
// package name, the imports the parameter types need and oaCall (which decodes one input, calls the function and
// encodes what it returned) filled in, then runs `go test -run ^TestOpenarcRun$` in the sandbox. It reads the plan (a
// JSON array of argument lists) and prints the JSON lines the JavaScript harness prints (core/harness.ts runOracle):
// one {name, ok, actual: {args, got, oracle, gotAfter?}} per input, then {done: n}, each behind oaMark.
// A call that runs longer than 5 s reports a timeout; since a goroutine cannot be stopped, the run then continues in a
// fresh process: the test binary supervises children (itself, OPENARC_CHILD set) that start at OPENARC_FROM.
package PACKAGE

import (
	oaJSON "encoding/json"
	oaFmt "fmt"
	oaMath "math"
	oaOS "os"
	oaExec "os/exec"
	oaStrconv "strconv"
	oaStrings "strings"
	oaTesting "testing"
	oaTime "time"
	// openarc:imports
)

const oaMark = "\x1eopenarc "

type oaActual struct {
	Args     oaJSON.RawMessage   `json:"args"`
	Got      oaJSON.RawMessage   `json:"got"`
	Oracle   string              `json:"oracle"`
	GotAfter []oaJSON.RawMessage `json:"gotAfter,omitempty"`
}

type oaOutcome struct {
	Name   string   `json:"name"`
	Ok     bool     `json:"ok"`
	Actual oaActual `json:"actual"`
}

func oaThrows(msg string) oaJSON.RawMessage {
	b, _ := oaJSON.Marshal(map[string]string{"throws": msg})
	return b
}

// oaEncode: a result as JSON; NaN and the infinities as the harness tokens.
// ponytail: only a float result itself; a NaN inside a slice or struct reports that it cannot be encoded
func oaEncode(v any) oaJSON.RawMessage {
	f, isFloat := v.(float64)
	if f32, ok := v.(float32); ok {
		f, isFloat = float64(f32), true
	}
	if isFloat && (oaMath.IsNaN(f) || oaMath.IsInf(f, 0)) {
		t := "$NaN"
		if oaMath.IsInf(f, 1) {
			t = "$Infinity"
		} else if oaMath.IsInf(f, -1) {
			t = "$-Infinity"
		}
		return oaJSON.RawMessage(oaStrconv.Quote(t))
	}
	b, err := oaJSON.Marshal(v)
	if err != nil {
		b, _ = oaJSON.Marshal(oaFmt.Sprintf("openarc: cannot encode %T: %v", v, err))
	}
	return b
}

// oaDecode: the receiver (a list of at most one value: none is the zero value) and the arguments into their real
// types; rest is the variadic parameter's index (it takes every argument from there), -1 for none.
func oaDecode(in []oaJSON.RawMessage, recv any, vars []any, rest int) string {
	if recv != nil {
		var list []oaJSON.RawMessage
		if len(in) == 0 || oaJSON.Unmarshal(in[0], &list) != nil || len(list) > 1 {
			return "openarc: the receiver must be a list of at most one value"
		}
		if len(list) == 1 {
			if err := oaJSON.Unmarshal(list[0], recv); err != nil {
				return "openarc: the receiver does not fit its type: " + err.Error()
			}
		}
		in = in[1:]
	}
	if rest < 0 && len(in) > len(vars) {
		return oaFmt.Sprintf("openarc: %d arguments for %d parameters", len(in), len(vars))
	}
	for i, v := range vars {
		if i >= len(in) {
			break
		}
		raw := in[i]
		if i == rest {
			parts := []string{}
			for _, r := range in[i:] {
				parts = append(parts, string(r))
			}
			raw = oaJSON.RawMessage("[" + oaStrings.Join(parts, ",") + "]")
		}
		if err := oaJSON.Unmarshal(raw, v); err != nil {
			return oaFmt.Sprintf("openarc: argument %d does not fit its type: %v", i+1, err)
		}
	}
	return ""
}

// oaSnap: the arguments as JSON, the variadic one spread back into its elements.
func oaSnap(vars []any, rest int) []oaJSON.RawMessage {
	out := []oaJSON.RawMessage{}
	for i, v := range vars {
		b := oaEncode(v)
		if i == rest {
			var items []oaJSON.RawMessage
			oaJSON.Unmarshal(b, &items)
			out = append(out, items...)
			continue
		}
		out = append(out, b)
	}
	return out
}

// oaRun: one call on its own goroutine, under the per-call limit, a panic recovered as a thrown message. after: the
// arguments as the call left them, only when it changed them (the receiver list first, as given, for a method).
func oaRun(in []oaJSON.RawMessage) (got oaJSON.RawMessage, after []oaJSON.RawMessage, timedOut bool) {
	type res struct {
		got           oaJSON.RawMessage
		before, after []oaJSON.RawMessage
	}
	done := make(chan res, 1)
	go func() {
		var r res
		defer func() {
			if p := recover(); p != nil {
				r = res{got: oaThrows(oaFmt.Sprint(p))}
			}
			done <- r
		}()
		var vars []any
		var rest int
		r.got, vars, rest, r.before = oaCall(in)
		if vars != nil {
			r.after = oaSnap(vars, rest)
		}
	}()
	select {
	case r := <-done:
		if r.before == nil || oaFmt.Sprint(r.before) == oaFmt.Sprint(r.after) {
			return r.got, nil, false
		}
		if oaHasRecv {
			return r.got, append([]oaJSON.RawMessage{in[0]}, r.after...), false
		}
		return r.got, r.after, false
	case <-oaTime.After(5000 * oaTime.Millisecond):
		return oaThrows("timed out after 5000 ms (does it loop forever?)"), nil, true
	}
}

func oaPrint(i int, in []oaJSON.RawMessage, got oaJSON.RawMessage, after []oaJSON.RawMessage) {
	args, _ := oaJSON.Marshal(in)
	line, _ := oaJSON.Marshal(oaOutcome{Name: "#" + oaStrconv.Itoa(i+1), Actual: oaActual{Args: args, Got: got, Oracle: "__openarc_observe__", GotAfter: after}})
	oaFmt.Println(oaMark + string(line))
}

func TestOpenarcRun(t *oaTesting.T) {
	data, err := oaOS.ReadFile(oaOS.Getenv("OPENARC_PLAN"))
	var inputs [][]oaJSON.RawMessage
	if err == nil {
		err = oaJSON.Unmarshal(data, &inputs)
	}
	if err != nil {
		t.Fatal("openarc: no plan: ", err)
	}
	if oaOS.Getenv("OPENARC_CHILD") != "" {
		from, _ := oaStrconv.Atoi(oaOS.Getenv("OPENARC_FROM"))
		for i := from; i < len(inputs); i++ {
			got, after, timedOut := oaRun(inputs[i])
			oaPrint(i, inputs[i], got, after)
			if timedOut {
				oaOS.Exit(0) // the looping goroutine ends with this process
			}
		}
		return
	}
	for from := 0; from < len(inputs); {
		cmd := oaExec.Command(oaOS.Args[0], "-test.run=^TestOpenarcRun$")
		cmd.Env = append(oaOS.Environ(), "OPENARC_CHILD=1", "OPENARC_FROM="+oaStrconv.Itoa(from))
		var stderr oaStrings.Builder
		cmd.Stderr = &stderr
		out, _ := cmd.Output()
		n := 0
		for _, line := range oaStrings.Split(string(out), "\n") {
			if i := oaStrings.Index(line, oaMark); i >= 0 {
				oaFmt.Println(line[i:])
				n++
			}
		}
		from += n
		if n == 0 { // the process ended on this input without an outcome (os.Exit, a fatal error): that is its outcome
			why := "the process ended"
			if cmd.ProcessState != nil {
				why += " (exit " + oaStrconv.Itoa(cmd.ProcessState.ExitCode()) + ")"
			}
			for _, l := range oaStrings.Split(stderr.String(), "\n") {
				if l = oaStrings.TrimSpace(l); l != "" {
					why += ": " + l
					break
				}
			}
			oaPrint(from, inputs[from], oaThrows(why), nil)
			from++
		}
	}
	oaFmt.Println(oaMark + `{"done":` + oaStrconv.Itoa(len(inputs)) + `}`)
}
