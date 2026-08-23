def 指南针() -> str:
    return "north"


def describe_compass() -> str:
    return 指南针()


def summarize() -> str:
    return f"heading: {describe_compass()}"
