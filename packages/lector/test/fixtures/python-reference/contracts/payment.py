from abc import ABC, abstractmethod
from typing import Protocol


class Order:
    def __init__(self, amount: int) -> None:
        self.amount = amount


class Receipt:
    def __init__(self, order: Order, processed: bool) -> None:
        self.order = order
        self.processed = processed


class PaymentProcessor(ABC):
    @abstractmethod
    def process(self, order: Order) -> Receipt: ...


class Describable(Protocol):
    def describe(self) -> str: ...
