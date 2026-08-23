package app

import "fixture.lector.invalid/gomod-reference/contracts"

type PremiumOrder struct {
	contracts.Order
	LoyaltyPoints int
}
