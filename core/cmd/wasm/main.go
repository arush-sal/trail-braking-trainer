//go:build js && wasm

// Command wasm exposes the core to the browser as the global tbtCore object.
package main

import (
	"syscall/js"

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

func main() {
	js.Global().Set("tbtCore", map[string]any{
		"version":       js.FuncOf(func(js.Value, []js.Value) any { return version }),
		"validateFrame": js.FuncOf(validateFrame),
	})
	select {}
}
