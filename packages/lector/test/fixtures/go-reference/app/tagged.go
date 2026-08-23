//go:build fixturetag

package app

// TaggedOnly only compiles when the fixturetag build tag is explicitly
// requested (go build -tags fixturetag) -- excluded from a default build,
// which is exactly the scenario worth proving Lector's discovery handles
// explicitly rather than silently including or crashing on it.
func TaggedOnly() string {
	return "tagged"
}
