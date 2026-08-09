# Boardex OS support matrix

Backend-owner doc. What runs where, and how lab-equipment access ("drivers")
works on each platform. `boardex-doctor` (from `boardex-core`) checks a
machine against this matrix.

## The driver policy in one paragraph

Boardex ships **no kernel drivers and no vendor blobs**. All hardware access
goes through two user-space seams: debug probes via **pyOCD + libusb** (a pip
install), and logic analyzers via a system-installed **sigrok-cli**
(libsigrok). Everything OS-specific is therefore an *access-permission*
problem (udev rules, WinUSB binding), not a kernel-module problem. Vendor
firmware that is not redistributable (Kingst LA FPGA bitstreams) stays
user-extracted — `docs/kingst-la-bringup.md` documents the flow. New hardware
is added as an adapter package behind the `boardex.target_backends` /
`boardex.logic_backends` entry points, never as OS-specific code in the
generic layers.

## Tiers

| Component | Linux | macOS | Windows |
|---|---|---|---|
| Python servers (core/target/logic/runner), pytest | Tier 1 — CI-gated | Tier 1 — CI-gated | Tier 1 — CI-gated |
| Debug probes (pyOCD: ST-Link, CMSIS-DAP) | Tier 1 — primary bench OS | Tier 2 — works via libusb | Tier 2 — needs driver binding |
| Logic analyzers (sigrok: Kingst, fx2lafw) | Tier 1 — documented bring-up | Tier 3 — subject to upstream libsigrok support | Tier 3 — subject to upstream libsigrok support |
| Firmware builds (arm-none-eabi-gcc, make) | Tier 1 — CI builds examples | Tier 2 | Tier 2 — POSIX make recipes not guaranteed |
| UI / contract / mock runner (Node >= 20) | Tier 1 — CI-gated | Tier 1 | Tier 1 |

- **Tier 1**: exercised by CI or by the documented bench setup; regressions
  are bugs.
- **Tier 2**: expected to work, verified ad hoc; platform caveats below.
- **Tier 3**: best effort; capability depends on upstream (libsigrok) rather
  than Boardex code.

CI runs the entire hardware-free pytest suite on all three OSes
(`.github/workflows/ci.yml`) — the *software* layer is proven portable.
Hardware-in-the-loop verification is manual by design (CI-for-hardware is
deferred, BIBLE §2.3 #9) and currently happens on a Linux bench.

## Per-OS notes

### Linux (primary bench OS)

- Probes: install `servers/boardex-target/contrib/udev/49-boardex-probes.rules`
  (see the README next to it) for non-root access.
- Logic analyzers: libsigrok's `60-libsigrok.rules`; Kingst LA needs a
  git-master libsigrok build + user-extracted firmware —
  `docs/kingst-la-bringup.md`.

### macOS

- No kernel driver needed: pyOCD and libsigrok talk libusb directly.
  `brew install libusb` if enumeration fails.
- sigrok/Kingst support is weaker upstream than on Linux; treat LA capture as
  best effort.

### Windows

- Probes enumerate once a WinUSB-compatible driver is bound to the interface:
  ST-Link via ST's driver package, generic CMSIS-DAP via Zadig/WinUSB if the
  default HID path fails.
- Logic analyzers: install `sigrok-cli`, add it to `PATH`, bind WinUSB via
  Zadig — `docs/windows-sigrok-bringup.md`.
- Firmware builds: the example Makefiles use POSIX recipes; use WSL, Git
  Bash's make, or drive the compiler directly.

## Checking a machine

```bash
pip install boardex-core  # or any release wheel set
boardex-doctor
```

Reports Python version, pyOCD + probe enumeration, `sigrok-cli`,
`arm-none-eabi-gcc`, and the per-OS USB access state, with fix hints.
Missing bench tools are advisory (exit 0); only an unsupported Python is
fatal (exit 1).
