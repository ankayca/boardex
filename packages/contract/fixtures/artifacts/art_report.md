# Validation Report — BME280 bring-up on Nucleo-F303RE

Run: `bme280_run_001` · 2026-07-07 · 2 iterations · Result: **PASS** (3/3 checks)

## Objective

Bring up the BME280 environmental sensor over I2C on the Nucleo-F303RE.
Verify I2C timing and confirm valid temperature/humidity readings over serial.

## Board & firmware context

- Board: Nucleo-F303RE (STM32F303RE, Cortex-M4). Powered over USB (manual power, 3V3 confirmed).
- Sensor: BME280 breakout on I2C1 — SCL = PB8, SDA = PB9 (AF4, open-drain, 4.7 kΩ pull-ups on the breakout), SDO tied low → 7-bit address 0x76.
- Firmware: `/bench/firmware/bme280-f303re` — single-file bare-metal `main.c` (no HAL, no libc), built with `make` (arm-none-eabi-gcc 13.2.1), console on USART2 (ST-Link VCP, 115200 8N1).
- Instruments: ST-Link (on-board, via pyOCD), Kingst LA2016 logic analyzer (sigrok), serial on `/dev/ttyACM0`.

## Procedure

1. Read the board profile and BME280 datasheet (§5.4.1: address 0x76 with SDO low; chip id register 0xD0 reads 0x60).
2. Added a register-level I2C1 driver (100 kHz standard mode, TIMINGR 0x10420F13 from the 8 MHz HSI) and a BME280 init/read loop to `main.c` — see **Code diff — BME280 driver (iteration 1)**.
3. Built (**Build log (iteration 1)**) and, after approval, flashed via pyOCD (**Flash log (iteration 1)**).
4. Captured the first post-reset I2C activity with the LA2016 at 4 MHz while reading 60 s of serial output.
5. Evaluated the three measurement checks. Two failed; diagnosed, proposed a fix, and — after approval — ran iteration 2 (edit, rebuild, re-flash, re-capture, re-evaluate).
6. Generated this report.

## Measurement results

| Requirement | Expected | Iteration 1 | Iteration 2 | Verdict | Evidence |
|---|---|---|---|---|---|
| `i2c_clock` — SCL frequency | 90–110 kHz | 99.6 kHz | 99.7 kHz | **PASS** | SCL frequency measurement (iteration 2) |
| `device_ack` — BME280 ACKs 0x76 | ACK | NACK on every address phase | ACK on all 15 transactions | **PASS** | I2C protocol decode (iteration 2) |
| `serial_output` — `TEMP=<t> HUM=<h>` on console | pattern match | no match in 60 s (I2C timeouts) | `TEMP=24.3 HUM=41.2` at ~1 Hz | **PASS** | Serial log (iteration 2) |

Iteration-1 failure evidence: **I2C protocol decode (iteration 1)**, **Serial log (iteration 1)**.

## Root cause & fix

Iteration 1 loaded the 7-bit address `0x76` into I2C1 CR2 **unshifted**. On the STM32F3,
`CR2.SADD[7:1]` carries the 7-bit address — the field holds the address byte as it appears
on the wire. With `SADD = 0x76`, the hardware transmitted 7-bit address `0x3B`
(wire byte `0x76`), which nothing on the bus answers: the decode shows a clean
`ADDRESS WRITE: 76` followed by NACK on every attempt, while SCL timing was already
in spec (99.6 kHz). The firmware surfaced this as TXIS timeouts on serial.

The fix (iteration 2) composes SADD from `0x76 << 1` (`BME280_SADD`) in all three CR2
loads. After re-flash, the sensor ACKs, chip id 0xD0 reads 0x60, and calibrated readings
stream on serial.

## Code changes summary

- Iteration 1 — **Code diff — BME280 driver (iteration 1)**: added I2C1 driver (init, bounded-spin waits, register write / repeated-start read), BME280 calibration load and Bosch integer compensation, 1 Hz TEMP/HUM console output (+220 lines in `main.c`). Contains the address bug.
- Iteration 2 — **Code diff — I2C address fix (iteration 2)**: introduced `BME280_SADD ((uint32_t)BME280_ADDR << 1)` and used it in the three CR2 loads (4 hunks, `main.c` only).

## Artifacts index

| Label | Kind |
|---|---|
| Code diff — BME280 driver (iteration 1) | code_diff |
| Build log (iteration 1) | build_log |
| Flash log (iteration 1) | flash_log |
| I2C protocol decode (iteration 1) | protocol_decode |
| SCL frequency measurement (iteration 1) | timing_measurement |
| Serial log (iteration 1) | serial_log |
| Code diff — I2C address fix (iteration 2) | code_diff |
| Build log (iteration 2) | build_log |
| Flash log (iteration 2) | flash_log |
| I2C protocol decode (iteration 2) | protocol_decode |
| SCL frequency measurement (iteration 2) | timing_measurement |
| Serial log (iteration 2) | serial_log |

## Reproduction steps

1. Wire the BME280 breakout to the Nucleo-F303RE: SCL→PB8, SDA→PB9, SDO→GND, VDD/VDDIO→3V3, GND→GND. Confirm 3V3 before powering (manual power mode).
2. `cd /bench/firmware/bme280-f303re && make clean && make`
3. `pyocd flash --target stm32f303retx --frequency 4000000 bme280-f303re.elf`
4. Attach the LA2016 (D0→SCL, D1→SDA, GND common); capture 2 s at 4 MHz, trigger on SCL falling, resetting the target as the capture arms. Decode as I2C and check the address phase ACKs and SCL frequency.
5. `picocom -b 115200 /dev/ttyACM0` — expect `BME280 chip id: 0x60 (OK)` and `TEMP=… HUM=…` lines at ~1 Hz.
