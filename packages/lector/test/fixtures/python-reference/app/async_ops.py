import asyncio


async def fetch_receipt() -> str:
    await asyncio.sleep(0)
    return "receipt"


async def fetch_receipt_twice() -> str:
    await fetch_receipt()
    return await fetch_receipt()
