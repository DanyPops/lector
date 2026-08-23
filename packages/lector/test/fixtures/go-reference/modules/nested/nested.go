package nested

// NestedMarker proves the go.work workspace mode makes gopls treat this
// separately-moduled subdirectory as part of the same live workspace scope.
func NestedMarker() string {
	return "nested"
}
