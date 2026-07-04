# blinky-f303re

A minimal, **bare-metal** blinky for the NUCLEO-F303RE. Its only job is to be a
zero-dependency firmware for validating Boardex's flash path end-to-end. It blinks
the onboard user LED **LD2 (PA5)**.

No HAL, no libc — just a tiny vector table + startup that runs `main()`.

> For real project/validation firmware, Boardex will standardise on **Zephyr**
> (`ztest`/`twister` for structured pass/fail results, plus RTT logging). This
> bare-metal blob is intentionally just a bring-up smoke test.

## Build

Needs an `arm-none-eabi` toolchain on `PATH` (or pass `CROSS=`):

```bash
make                                   # if arm-none-eabi-gcc is on PATH
make CROSS=/path/to/toolchain/bin/arm-none-eabi-   # explicit toolchain
```

Produces `blinky-f303re.elf` and `blinky-f303re.bin`.

## Flash via Boardex

```python
from boardex_target.server import list_targets, flash_firmware
dev = list_targets()["data"]["devices"][0]["device_id"]
flash_firmware(device_id=dev,
               firmware_path="firmware/blinky-f303re/blinky-f303re.elf",
               target="stm32f303retx")
```

Expected result: `verdict: pass`, and LD2 begins blinking.
