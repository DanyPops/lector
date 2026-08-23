from dataclasses import dataclass
from typing import TypeVar

T = TypeVar("T")


def logged(cls: T) -> T:
    setattr(cls, "logged", True)
    return cls


@logged
@dataclass
class LegacyGateway:
    name: str

    def describe(self) -> str:
        return f"gateway:{self.name}"
