from contracts.payment import Order, PaymentProcessor, Receipt


class StripeProcessor(PaymentProcessor):
    def process(self, order: Order) -> Receipt:
        return Receipt(order, True)

    @staticmethod
    def create() -> PaymentProcessor:
        return StripeProcessor()
