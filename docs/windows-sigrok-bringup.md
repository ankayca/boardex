# Bringing up a logic analyzer on Windows (sigrok-cli)

`boardex-logic` drives logic analyzers through a system-installed **`sigrok-cli`**
binary. On Windows there are two prerequisites the Boardex installer does **not**
provide:

1. **sigrok-cli** itself (libsigrok + CLI), on your `PATH`.
2. **WinUSB binding** for the analyzer USB interface (via Zadig). Boardex ships
   no kernel drivers; libsigrok talks to the device through WinUSB, same as
   PulseView.

This doc covers the flow we verified on a Windows bench with a cheap **Saleae
clone** (FX2 chip, `fx2lafw` driver). Kingst LA analyzers need extra firmware
steps — see [`kingst-la-bringup.md`](kingst-la-bringup.md).

---

## 1. Install sigrok-cli

Download and run the **64-bit nightly release installer** (recommended — includes
recent drivers such as `fx2lafw` and bundled firmware for FX2 clones):

<https://sigrok.org/download/binary/sigrok-cli/sigrok-cli-NIGHTLY-x86_64-release-installer.exe>

Default install location:

```text
C:\Program Files\sigrok\sigrok-cli\sigrok-cli.exe
```

If the nightly build misbehaves during capture (see [Troubleshooting](#troubleshooting)),
try the stable **0.7.2** installer instead:

<https://sigrok.org/download/binary/sigrok-cli/sigrok-cli-0.7.2-x86_64-installer.exe>

Chocolatey (`choco install sigrok-cli`) is optional; it is not required and may
not be present on a fresh Windows machine.

---

## 2. Install the Visual C++ 2010 Redistributable

sigrok's Windows builds still depend on **MSVCR100.dll**. Without it,
`sigrok-cli.exe` may exit silently — no `--version`, no `--help`, no error text
in PowerShell.

Install **both** packages, then reboot (or close all terminals):

- x64: <https://www.microsoft.com/en-us/download/details.aspx?id=26999>
- x86: <https://www.microsoft.com/en-us/download/details.aspx?id=8328>

Sanity check (use `.\` — see step 3):

```powershell
cd "C:\Program Files\sigrok\sigrok-cli"
.\sigrok-cli.exe --version
```

You should see a banner like `sigrok-cli 0.8.0-git-…` with libsigrok version
lines below it.

---

## 3. Add sigrok-cli to PATH

The sigrok installer does not always add its folder to the user `PATH`.
Boardex resolves the binary with `shutil.which("sigrok-cli")` — it must be
findable **without** `cd` or `.\`.

Run once in PowerShell:

```powershell
$bin = "C:\Program Files\sigrok\sigrok-cli"
$path = [Environment]::GetEnvironmentVariable("Path", "User")
if ($path -notlike "*$bin*") {
  [Environment]::SetEnvironmentVariable("Path", "$path;$bin", "User")
}
```

Close **all** PowerShell, CMD, Cursor, and Boardex terminals, then open a new
window:

```powershell
sigrok-cli --version
where.exe sigrok-cli
```

Expected:

```text
C:\Program Files\sigrok\sigrok-cli\sigrok-cli.exe
```

### PowerShell note

Even when you `cd` into the install folder, PowerShell does **not** run programs
from the current directory unless you prefix them:

```powershell
.\sigrok-cli.exe --scan    # correct
sigrok-cli.exe --scan      # wrong — "not recognized"
```

After PATH is set, `sigrok-cli --scan` works from any directory.

---

## 4. Bind WinUSB with Zadig

Vendor drivers (Saleae Logic, KingstVIS, etc.) do **not** work with libsigrok.
Replace them with **WinUSB** using [Zadig](https://zadig.akeo.ie/) (a copy ships
with the sigrok installer under the Start menu).

1. Plug in the logic analyzer.
2. Zadig → **Options** → enable **List All Devices**.
3. Select the analyzer in the dropdown (may appear as a generic name before
   firmware upload).
4. Set the target driver to **WinUSB** (not libusb-win32, libusbK, or USB serial
   CDC).
5. Click **Replace Driver** / **Install Driver**.

After success, Device Manager often shows **Unknown device** under USB devices
with **WinUSB** as the driver — that is normal. What matters is no yellow
warning icon and `--scan` listing your hardware.

Zadig is also used for CMSIS-DAP debug probes when the default HID path fails;
see [`SUPPORT_MATRIX.md`](SUPPORT_MATRIX.md).

---

## 5. Verify enumeration

```powershell
sigrok-cli --scan
```

Example output for a Saleae clone (FX2):

```text
fx2lafw - Saleae Logic with 8 channels: D0 D1 D2 D3 D4 D5 D6 D7
```

You may also see:

- `demo - Demo device …` — sigrok's built-in fake device; ignore it.
- `sr: asix-omega-rtm-cli: Cannot execute RTM CLI process …` — unrelated driver
  noise; safe to ignore if your analyzer appears.

Optional capture smoke test:

```powershell
sigrok-cli -d fx2lafw --config samplerate=1m --samples 1000 `
  --channels D0,D1 -O csv:label=channel:dedup=false | Select-Object -First 5
```

---

## 6. Verify Boardex sees the same device

```powershell
boardex doctor
```

The `sigrok-cli` check should be **ok**. With the runner up, `GET /bench` and MCP
`list_analyzers` should report a device whose backend is `sigrok` and whose
driver is `fx2lafw` (or `kingst-la2016` for Kingst LA hardware).

---

## Troubleshooting

Symptoms below came from real Windows bring-up. Work through them in order.

### `sigrok-cli` is not recognized (PowerShell)

| Cause | Fix |
|---|---|
| Not installed | Run the nightly or 0.7.2 installer (step 1). |
| Not on `PATH` | Add `C:\Program Files\sigrok\sigrok-cli` to the user `PATH` (step 3); restart terminals. |
| Running from install dir without `.\` | Use `.\sigrok-cli.exe` or fix `PATH` so `sigrok-cli` works globally. |

### `sigrok-cli` runs but prints nothing (no `--version`, no `--help`)

| Cause | Fix |
|---|---|
| Missing VC++ 2010 Redistributable | Install x64 and x86 packages (step 2); reboot. |
| Corrupt or partial install | Re-run the installer; confirm the folder contains many `.dll` files, not just `sigrok-cli.exe`. |
| Still silent after redist | Check **Event Viewer → Windows Logs → Application** for a fault on `sigrok-cli.exe` (often `MSVCR100.dll`). Try the stable 0.7.2 build. |

### Device Manager shows "Unknown device" after Zadig

**Expected** for WinUSB-bound analyzers. WinUSB does not install a friendly
vendor name. Confirm **Properties → Driver → WinUSB** and no warning icon.

### `--scan` lists only `demo`, not the analyzer

| Cause | Fix |
|---|---|
| WinUSB not bound | Repeat Zadig with **WinUSB** on the correct USB interface (step 4). |
| Wrong Zadig driver chosen | Use **WinUSB only** — not libusb-win32, libusbK, or USB serial CDC. |
| FX2 double-enumeration | Many clones (Saleae FX2) appear twice: bind WinUSB on the **initial** device, run `sigrok-cli --scan` (uploads firmware), then bind WinUSB again on the **new** entry after replug. Same physical USB port. |
| Different USB port | Windows binds WinUSB per port. Re-run Zadig if you change ports. |
| Bad USB cable | Clone analyzers often ship poor cables; try a known-good cable, direct to the PC (no hub). |

### `--scan` finds the device but capture fails

| Cause | Fix |
|---|---|
| Nightly regression on FX2 | Uninstall nightly; install **sigrok-cli 0.7.2** x64. Some nightlies log `Failed to get libusb file descriptors` during acquisition. |
| Kingst LA missing firmware | Scan may work; capture needs blobs in `%LOCALAPPDATA%\sigrok-firmware\` — see [`kingst-la-bringup.md`](kingst-la-bringup.md). |
| Device busy | Close PulseView or other apps holding the analyzer. |

### Harmless log lines

```text
sr: asix-omega-rtm-cli: Cannot execute RTM CLI process: …
```

This is an unrelated optional driver probe. Ignore it when `fx2lafw` (or your
target driver) appears in the device list.

### Clone Saleae vs genuine Saleae

Boardex uses sigrok's **`fx2lafw`** driver for cheap FX2 clones, not Saleae's
official application. Clones are supported; bind **WinUSB** and expect the scan
line `fx2lafw - Saleae Logic with 8 channels: …`.

---

## References

- sigrok Windows wiki: <https://sigrok.org/wiki/Windows>
- sigrok downloads: <https://sigrok.org/wiki/Downloads>
- Boardex OS tiers: [`SUPPORT_MATRIX.md`](SUPPORT_MATRIX.md)
- Kingst LA firmware: [`kingst-la-bringup.md`](kingst-la-bringup.md)
