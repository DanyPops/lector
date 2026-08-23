from contracts.payment import Order, PaymentProcessor, Receipt


def run_checkout(processor: PaymentProcessor, order: Order) -> Receipt:
    return processor.process(order)


def run_checkout_twice(processor: PaymentProcessor, order: Order) -> Receipt:
    run_checkout(processor, order)
    return run_checkout(processor, order)
