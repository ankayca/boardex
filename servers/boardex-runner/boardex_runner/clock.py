"""Run pacing clocks.

The engine never calls ``asyncio.sleep`` or ``datetime.now`` directly: it asks
its clock. The real bench uses wall time. The fake bench uses a virtual clock
so a simulated run can carry realistic timestamps (and record realistic
``delayMs`` pacing, §10.3) while executing quickly under a SPEED factor.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone


def iso(ts: datetime) -> str:
    """UTC ISO 8601 with milliseconds and Z, matching the house wire format."""
    return ts.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class Clock:
    """Wall-clock: `sleep(ms)` waits for real ms and `now()` is real time."""

    def now(self) -> datetime:
        return datetime.now(timezone.utc)

    def now_iso(self) -> str:
        return iso(self.now())

    async def sleep(self, ms: float) -> None:
        await asyncio.sleep(max(0.0, ms) / 1000.0)


class VirtualClock(Clock):
    """A clock whose time advances by the *unscaled* delay while the process
    sleeps only ``delay / speed`` — deterministic timestamps at any speed.

    ``dilation`` stretches narrative time relative to the scripted delays (a
    simulated bench's canned pacing is much tighter than a real bench's build/
    capture waits); recorded timestamps then span a realistic run without the
    process taking that long.
    """

    def __init__(
        self,
        start: datetime | None = None,
        speed: float = 1.0,
        dilation: float = 1.0,
    ) -> None:
        self._now = start or datetime.now(timezone.utc)
        self.speed = max(speed, 1e-9)
        self.dilation = max(dilation, 1e-9)

    def now(self) -> datetime:
        return self._now

    async def sleep(self, ms: float) -> None:
        ms = max(0.0, ms) * self.dilation
        await asyncio.sleep(ms / 1000.0 / self.speed)
        self._now = self._now + timedelta(milliseconds=ms)
