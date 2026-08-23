package app

type Ordered interface {
	~int | ~int64 | ~float64
}

func Max[T Ordered](a, b T) T {
	if a > b {
		return a
	}
	return b
}
