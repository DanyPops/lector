package app

type Score = float64

func NormalizeScore(raw Score) Score {
	if raw < 0 {
		return 0
	}
	return raw
}
