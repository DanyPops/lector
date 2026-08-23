from contracts.payment import Order


def bad_amount() -> int:
    order = Order(amount="not-a-number")
    return order.amount
