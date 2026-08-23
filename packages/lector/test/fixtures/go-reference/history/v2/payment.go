package contracts

type PurchaseOrder struct {
	Amount   int
	Currency string
}

type Receipt struct {
	Order     PurchaseOrder
	Processed bool
}

type PaymentProcessor interface {
	Process(order PurchaseOrder) (Receipt, error)
}
