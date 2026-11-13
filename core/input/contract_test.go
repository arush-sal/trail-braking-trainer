package input

import (
	"os"
	"path/filepath"
	"testing"
)

// Shared fixtures are also asserted through the real WASM (make test-wasm).
func TestContractFixtures(t *testing.T) {
	for dir, wantOK := range map[string]bool{"valid": true, "invalid": false} {
		files, err := filepath.Glob(filepath.Join("..", "..", "tests", "contracts", "frames", dir, "*.json"))
		if err != nil || len(files) == 0 {
			t.Fatalf("no %s fixtures: %v", dir, err)
		}
		for _, p := range files {
			b, err := os.ReadFile(p) //nolint:gosec // fixture paths from Glob
			if err != nil {
				t.Fatal(err)
			}
			if _, err := Decode(b); (err == nil) != wantOK {
				t.Errorf("%s: want ok=%v, err=%v", p, wantOK, err)
			}
		}
	}
}
