from abc import ABC, abstractmethod


class PurchaseOrder:
    def __init__(self, amount: int, currency: str) -> None:
        self.amount = amount
        self.currency = currency


class Receipt:
    def __init__(self, order: PurchaseOrder, processed: bool) -> None:
        self.order = order
        self.processed = processed


class PaymentProcessor(ABC):
    @abstractmethod
    def process(self, order: PurchaseOrder) -> Receipt: ...
