"""sigrok adapter: capture & decode with any libsigrok-supported analyzer.

Together with ``sigrok_cli`` and ``parse`` this is the only code that knows
sigrok exists. It satisfies the ``LogicAnalyzer`` contract by driving the
``sigrok-cli`` binary and translating its text output into structured results.

A single ``sigrok-cli`` build covers many analyzers (Kingst LA series via the
``kingst-la2016`` driver, cheap FX2 clones via ``fx2lafw``, ...), so adding a
new supported analyzer is usually a firmware/driver concern, not new code here.
"""

from __future__ import annotations

from boardex_core import DeviceInfo, LogicAnalyzer, OperationResult, Verdict

from .. import analyze, decode, parse, sigrok_cli


class SigrokAdapter(LogicAnalyzer):
    """Wraps ``sigrok-cli`` to satisfy the Boardex ``LogicAnalyzer`` contract."""

    backend_name = "sigrok"

    def __init__(self) -> None:
        # device_id -> ordered channel names, so agent-facing integer channel
        # indices can be mapped to whatever this device calls its channels
        # (D0.., CH0.., ...). Populated on scan, refreshed lazily on demand.
        self._channels: dict[str, list[str]] = {}

    def is_available(self) -> bool:
        return sigrok_cli.sigrok_available()

    # -- discovery ---------------------------------------------------------

    def scan(self) -> list[DeviceInfo]:
        if not self.is_available():
            return []
        devices: list[DeviceInfo] = []
        for dev in parse.parse_scan(sigrok_cli.scan_raw()):
            if dev.channels:
                self._channels[self._device_id(dev.spec)] = dev.channels
            vendor, _, model = dev.model.partition(" ")
            devices.append(
                DeviceInfo(
                    device_id=self._device_id(dev.spec),
                    kind="logic_analyzer",
                    vendor=vendor or dev.driver,
                    model=model or dev.model,
                    serial=dev.conn,
                    backend=self.backend_name,
                    extra={
                        "driver": dev.driver,
                        "conn": dev.conn,
                        "channels": dev.channels,
                        "sigrok_spec": dev.spec,
                    },
                )
            )
        return devices

    # -- operations --------------------------------------------------------

    def capabilities(self, device_id: str) -> OperationResult:
        spec = self._spec(device_id)
        caps = parse.parse_show(sigrok_cli.show_raw(spec))
        n = len(caps["channels"])
        max_hz = caps["max_sample_rate_hz"]
        return OperationResult.passed(
            f"{n}-channel analyzer, up to {self._hz(max_hz)}.",
            channels=caps["channels"],
            channel_count=n,
            max_sample_rate_hz=max_hz,
            samplerates=caps["samplerates"],
            triggers=caps["triggers"] or ["rising", "falling", "high", "low"],
        )

    def capture(
        self,
        device_id: str,
        *,
        channels: list[int] | None = None,
        sample_rate_hz: int = 1_000_000,
        num_samples: int | None = None,
        duration_s: float | None = None,
        trigger_channel: int | None = None,
        trigger_edge: str = "rising",
    ) -> OperationResult:
        spec = self._spec(device_id)
        n = self._resolve_num_samples(num_samples, duration_s, sample_rate_hz)
        if n is None:
            return OperationResult.errored(
                "Specify num_samples or duration_s for the capture."
            )

        trigger = None
        if trigger_channel is not None:
            edge = sigrok_cli.TRIGGER_EDGES.get(trigger_edge)
            if edge is None:
                return OperationResult.errored(
                    f"Unknown trigger_edge '{trigger_edge}'. Use one of "
                    f"{sorted(sigrok_cli.TRIGGER_EDGES)}."
                )
            trigger = (self._channel_name(device_id, trigger_channel), edge)

        csv = sigrok_cli.capture_csv(
            spec,
            sample_rate_hz=sample_rate_hz,
            num_samples=n,
            channels=(
                [self._channel_name(device_id, c) for c in channels]
                if channels
                else None
            ),
            trigger=trigger,
        )
        # Clamp the (often over-delivered) stream to the requested window so
        # timing is deterministic, then reduce to measurements the agent can
        # branch on and a size-bounded transition list.
        result = analyze.limit_samples(parse.parse_csv(csv), n)
        samples = result["num_samples"]
        measurements = analyze.summarize(
            result["transitions"], samples, sample_rate_hz
        )
        transitions, truncated = analyze.bound_transitions(result["transitions"])

        active = [name for name, m in measurements.items() if m["active"]]
        summary = (
            f"Captured {samples} samples "
            f"({self._duration(samples, sample_rate_hz)}) on "
            f"{len(result['channels'])} channel(s); "
            f"{len(active)} active: {', '.join(active) or 'none'}."
        )
        res = OperationResult(
            Verdict.PASS,
            summary,
            data={
                "sample_rate_hz": sample_rate_hz,
                "num_samples": samples,
                "duration_s": samples / sample_rate_hz if sample_rate_hz else None,
                "channels": result["channels"],
                "measurements": measurements,
                "transitions": transitions,
            },
        )
        if truncated:
            res.warnings.append(
                f"Transition lists clipped to {analyze.MAX_EDGES_PER_CHANNEL} "
                "edges/channel for size; see measurements for full counts."
            )
        return res

    def decode(
        self,
        device_id: str,
        protocol: str,
        channel_map: dict[str, int],
        *,
        sample_rate_hz: int = 1_000_000,
        num_samples: int | None = None,
        duration_s: float | None = None,
        options: dict[str, str] | None = None,
        trigger_channel: int | None = None,
        trigger_edge: str = "rising",
    ) -> OperationResult:
        spec = self._spec(device_id)
        n = self._resolve_num_samples(num_samples, duration_s, sample_rate_hz)
        if n is None:
            return OperationResult.errored(
                "Specify num_samples or duration_s for the decode capture."
            )

        channel_names = [
            self._channel_name(device_id, idx) for idx in channel_map.values()
        ]
        trigger = None
        if trigger_channel is not None:
            edge = sigrok_cli.TRIGGER_EDGES.get(trigger_edge)
            if edge is None:
                return OperationResult.errored(
                    f"Unknown trigger_edge '{trigger_edge}'. Use one of "
                    f"{sorted(sigrok_cli.TRIGGER_EDGES)}."
                )
            trigger = (self._channel_name(device_id, trigger_channel), edge)

        text = sigrok_cli.decode_raw(
            spec,
            sample_rate_hz=sample_rate_hz,
            num_samples=n,
            protocol=protocol,
            channel_map={
                pin: self._channel_name(device_id, idx)
                for pin, idx in channel_map.items()
            },
            options=options,
            channels=sorted(set(channel_names)),
            trigger=trigger,
        )
        annotations = parse.parse_annotations(text)
        transactions = decode.decode_transactions(protocol, annotations)
        bus_state = _bus_state(annotations, transactions)

        if transactions:
            verdict = OperationResult.passed
            summary = (
                f"Decoded {len(transactions)} {protocol} transaction(s) "
                f"from {len(annotations)} annotation(s)."
            )
        elif annotations:
            verdict = OperationResult.inconclusive
            summary = (
                f"Saw {len(annotations)} {protocol} annotation(s) but could not "
                "form complete transactions (partial capture or unknown format)."
            )
        else:
            verdict = OperationResult.inconclusive
            summary = f"No {protocol} activity decoded (idle bus or wrong channel map)."

        return verdict(
            summary,
            protocol=protocol,
            bus_state=bus_state,
            annotations=annotations,
            transactions=transactions,
            trigger_channel=trigger_channel,
            trigger_edge=trigger_edge if trigger_channel is not None else None,
        )

    # -- helpers -----------------------------------------------------------

    def _channel_name(self, device_id: str, index: int) -> str:
        """Map an agent-facing channel index to the device's channel name.

        Devices label channels differently (``D0..`` on FX2 clones, ``CH0..`` on
        Kingst); agents address them by integer index and we translate. Falls
        back to a ``--show`` query, then to ``D{index}`` if the device is silent.
        """
        names = self._channels.get(device_id)
        if names is None:
            try:
                names = parse.parse_show(sigrok_cli.show_raw(self._spec(device_id)))[
                    "channels"
                ]
                self._channels[device_id] = names
            except Exception:  # noqa: BLE001 - naming is best-effort
                names = []
        if 0 <= index < len(names):
            return names[index]
        return f"D{index}"

    @staticmethod
    def _resolve_num_samples(
        num_samples: int | None, duration_s: float | None, sample_rate_hz: int
    ) -> int | None:
        if num_samples is not None:
            return num_samples
        if duration_s is not None:
            return max(1, int(duration_s * sample_rate_hz))
        return None

    @staticmethod
    def _device_id(spec: str) -> str:
        """Namespaced, stable id wrapping the sigrok device spec."""
        return f"sigrok:{spec}"

    @staticmethod
    def _spec(device_id: str) -> str:
        return device_id.split(":", 1)[1] if ":" in device_id else device_id

    @staticmethod
    def _duration(samples: int, rate: int) -> str:
        if not rate:
            return "unknown"
        s = samples / rate
        for unit, mul in (("s", 1), ("ms", 1e3), ("us", 1e6)):
            if s * mul >= 1 or unit == "us":
                return f"{s * mul:.3g} {unit}"
        return f"{s:g} s"

    @staticmethod
    def _hz(hz: int | None) -> str:
        if not hz:
            return "unknown rate"
        for unit, div in (("GHz", 1e9), ("MHz", 1e6), ("kHz", 1e3)):
            if hz >= div:
                return f"{hz / div:g} {unit}"
        return f"{hz} Hz"


def _bus_state(annotations: list[dict], transactions: list[dict]) -> str:
    """Classify capture outcome for agent branching."""
    if not annotations:
        return "idle_bus"
    if transactions:
        return "decoded_ok"
    return "activity_no_decode"
