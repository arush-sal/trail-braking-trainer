//go:build js && wasm

// Command wasm exposes the core to the browser as the global tbtCore object.
// tbtCore.api maps 1:1 onto core/api.Runner (ADR 0007): JSON strings in,
// JSON strings out. All logic lives in core/api; this file is glue only.
package main

import (
	"encoding/json"
	"strconv"
	"syscall/js"

	"github.com/arush-sal/trail-braking-trainer/core/api"
	"github.com/arush-sal/trail-braking-trainer/core/input"
)

var version = "dev"

func validateFrame(_ js.Value, args []js.Value) any {
	if len(args) != 1 || args[0].Type() != js.TypeString {
		return "validateFrame: expected one JSON string argument"
	}
	if _, err := input.Decode([]byte(args[0].String())); err != nil {
		return err.Error()
	}
	return nil
}

func encode(v any) any {
	b, err := json.Marshal(v)
	if err != nil {
		return `{"apiVersion":1,"events":[],"error":"encode failed"}`
	}
	return string(b)
}

// fn wraps a call that needs the given JS argument types.
func fn(types []js.Type, call func(args []js.Value) any) js.Func {
	return js.FuncOf(func(_ js.Value, args []js.Value) any {
		if len(args) != len(types) {
			return encode(api.Result{APIVersion: api.APIVersion, Events: []api.Event{}, Error: "wrong number of arguments"})
		}
		for i, t := range types {
			if args[i].Type() != t {
				return encode(api.Result{APIVersion: api.APIVersion, Events: []api.Event{}, Error: "argument " + strconv.Itoa(i+1) + " must be a " + t.String()})
			}
		}
		return encode(call(args))
	})
}

func main() {
	r := api.New()
	str, num := js.TypeString, js.TypeNumber
	js.Global().Set("tbtCore", map[string]any{
		"version":       js.FuncOf(func(js.Value, []js.Value) any { return version }),
		"validateFrame": js.FuncOf(validateFrame),
		"api": map[string]any{
			"apiVersion":    api.APIVersion,
			"start":         fn([]js.Type{str}, func(a []js.Value) any { return r.Start([]byte(a[0].String())) }),
			"command":       fn([]js.Type{str, num}, func(a []js.Value) any { return r.Command(a[0].String(), a[1].Float()) }),
			"tick":          fn([]js.Type{num}, func(a []js.Value) any { return r.Tick(a[0].Float()) }),
			"observe":       fn([]js.Type{str}, func(a []js.Value) any { return r.ObserveJSON([]byte(a[0].String())) }),
			"snapshot":      fn([]js.Type{num}, func(a []js.Value) any { return r.Snapshot(a[0].Float()) }),
			"presets":       fn(nil, func([]js.Value) any { return api.Presets() }),
			"validateDrill": fn([]js.Type{str}, func(a []js.Value) any { return api.ValidateDrill([]byte(a[0].String())) }),
			"results":       fn([]js.Type{js.TypeBoolean}, func(a []js.Value) any { return r.Results(a[0].Bool()) }),
			"previewSamples": fn([]js.Type{str, num}, func(a []js.Value) any {
				return api.PreviewSamples([]byte(a[0].String()), a[1].Int())
			}),
		},
	})
	select {}
}
