package contracts

type Order struct {
	Amount int
}

type Receipt struct {
	Order     Order
	Processed bool
}

type PaymentProcessor interface {
	Process(order Order) (Receipt, error)
}
