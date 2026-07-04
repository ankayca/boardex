# Bringing up a Kingst LA analyzer (LA1010 / LA1016 / LA2016 / LA5016 / LA5032)

`boardex-logic` drives logic analyzers through the system `sigrok-cli`. For the
Kingst LA series there are three prerequisites the distro packages don't give you:

1. **A recent libsigrok.** The `kingst-la2016` driver was added *after* the last
   stable release (0.5.2). Debian bookworm ships 0.5.2, which has **no** Kingst
   driver (`sigrok-cli --scan` will not see the device). You must build
   libsigrok + sigrok-cli from **git master**.
2. **Vendor firmware + FPGA bitstream.** These analyzers ship blank: the driver
   uploads a Cypress FX2 firmware and an FPGA bitstream on every plug-in. Those
   blobs are proprietary and must be extracted from the KingstVIS software.
3. **USB permissions.** A udev rule so a non-root user (in `plugdev`) can open
   and re-enumerate the device.

Before firmware, the device shows up on USB as `77a1:01a2` with `bcdDevice 0.00`
and **zero endpoints** — that ID is shared by the whole LA series; the exact
model is read from EEPROM only *after* the FX2 firmware is uploaded.

---

## 1. Install build dependencies (needs sudo)

```bash
sudo apt update
sudo apt install -y \
  git build-essential autoconf automake libtool pkg-config \
  libglib2.0-dev libusb-1.0-0-dev libzip-dev libserialport-dev check \
  python3-dev python3-setuptools swig    # last three only for protocol decoders
```

## 2. Build libsigrok + sigrok-cli from git master

Installed into a user prefix so no `sudo make install` is needed. (Use
`--prefix=/usr/local` + `sudo make install` + `sudo ldconfig` instead if you
prefer a system install.)

```bash
export SIGROK_PREFIX="$HOME/.local/sigrok"
mkdir -p ~/src && cd ~/src

# libserialport is a sigrok dependency; the distro pkg above satisfies it, but
# build it too if libserialport-dev was unavailable:
# git clone git://sigrok.org/libserialport && cd libserialport && ./autogen.sh \
#   && ./configure --prefix="$SIGROK_PREFIX" && make -j && make install && cd ..

git clone https://github.com/sigrokproject/libsigrok.git
cd libsigrok
./autogen.sh
PKG_CONFIG_PATH="$SIGROK_PREFIX/lib/pkgconfig" \
  ./configure --prefix="$SIGROK_PREFIX" --disable-python
make -j"$(nproc)"
make install
cd ..

# (Optional, for decode_bus) protocol decoders:
git clone https://github.com/sigrokproject/libsigrokdecode.git
cd libsigrokdecode && ./autogen.sh \
  && PKG_CONFIG_PATH="$SIGROK_PREFIX/lib/pkgconfig" ./configure --prefix="$SIGROK_PREFIX" \
  && make -j"$(nproc)" && make install && cd ..

git clone https://github.com/sigrokproject/sigrok-cli.git
cd sigrok-cli
./autogen.sh
PKG_CONFIG_PATH="$SIGROK_PREFIX/lib/pkgconfig" \
  ./configure --prefix="$SIGROK_PREFIX"
make -j"$(nproc)"
make install
cd ..
```

Make the new build the default `sigrok-cli` (so `boardex-logic` uses it without
per-shell env tweaks). A wrapper on `~/.local/bin` (which precedes `/usr/bin` on
PATH) shadows the distro binary and sets its library path — no sudo, no touching
the system install:

```bash
cat > ~/.local/bin/sigrok-cli <<'EOF'
#!/bin/sh
SIGROK_PREFIX="$HOME/.local/sigrok"
export LD_LIBRARY_PATH="$SIGROK_PREFIX/lib:$LD_LIBRARY_PATH"
exec "$SIGROK_PREFIX/bin/sigrok-cli" "$@"
EOF
chmod +x ~/.local/bin/sigrok-cli

sigrok-cli --version            # libsigrok should now be > 0.5.2 (git)
sigrok-cli --list-supported | grep -i kingst   # kingst-la2016 should appear
```

## 3. Install the udev rule (needs sudo)

The KingstVIS installer already drops `/etc/udev/rules.d/99-Kingst.rules`
(`MODE=0666` for `77a1:01a*`), so if you've run KingstVIS's `install.sh` this is
already done — check with `ls /etc/udev/rules.d/ | grep -i kingst`. Otherwise:

```bash
sudo cp ~/src/libsigrok/contrib/60-libsigrok.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules && sudo udevadm trigger
# replug the analyzer afterwards
```

## 4. Extract the Kingst firmware/bitstream (no sudo)

Point the `sigrok-util` extractor at your installed KingstVIS binary. (The wiki
lists v3.5.x as known-good; in practice **v3.6.5 extracts cleanly too**, LA1010
bitstreams included — the extractor now handles the compressed Qt resources.)

```bash
cd ~/src
git clone https://github.com/sigrokproject/sigrok-util.git
mkdir -p /tmp/kingst-fw && cd /tmp/kingst-fw
# Note the path: firmware/kingst-la/ (not kingst-la2016/).
python3 ~/src/sigrok-util/firmware/kingst-la/sigrok-fwextract-kingst-la2016 \
  ~/Downloads/KingstVIS/KingstVIS
# Saves kingst-la-01a?.fw + kingst-la*-fpga.bitstream (all models) into the CWD.

mkdir -p ~/.local/share/sigrok-firmware
cp kingst-la-*.fw kingst-la*-fpga.bitstream ~/.local/share/sigrok-firmware/
```

Sanity check the FX2 firmware for the `01a2` USB id matches sigrok's known-good
checksum: `kingst-la-01a2.fw` should be `crc32=720551a9`.

> **LA1010 note:** it uses a Xilinx FPGA and is listed as *untested/should-work*
> in mainline (it's "an LA1016 without RAM", streaming-only, 100 MHz max). If
> mainline fails to configure the FPGA, use the community fork
> [`AlexUg/libsigrok`](https://github.com/AlexUg/sigrok) which targets the LA1010
> specifically (note: that fork *removes* LA2016 support — they conflict).

## 5. Verify end to end

```bash
sigrok-cli --scan
# -> kingst-la2016:conn=3.12 - Kingst LA1010 with 18 channels: CH0 ... CH15 PWM1 PWM2

# quick capture smoke test (Kingst channels are named CHn, not Dn)
sigrok-cli -d kingst-la2016 --config samplerate=1m --samples 1000 \
  --channels CH0,CH1 -O csv:label=channel:dedup=false | head
```

Notes on the LA1010 specifically:

- Channels are `CH0..CH15` (16 logic) plus `PWM1`/`PWM2` outputs — 18 "channels"
  total. `boardex-logic` addresses them by integer index and maps the index to
  the device's real channel name automatically.
- A harmless `kingst-la2016: Unexpected run state, want 0x85eX, got 0x00e1.` log
  line appears on scan; the device still enumerates and captures fine.
- It has **no sample memory** (streaming only), so a small `--samples` request
  can still return a large buffer (USB transfer granularity). `capture` reports
  the actual `num_samples`; the transition-list encoding keeps this cheap.

Then through Boardex (with the new sigrok on PATH):

```python
from boardex_logic.server import registry
dev = registry.scan()[0].device_id          # "sigrok:kingst-la2016:conn=..."
registry.resolve(dev).capabilities(dev)
registry.resolve(dev).capture(dev, channels=[0,1], sample_rate_hz=1_000_000, num_samples=10_000)
```

## Troubleshooting

- **`--scan` shows nothing:** wrong libsigrok on PATH (still 0.5.2), or the udev
  rule/replug step was skipped. Check `sigrok-cli --version`.
- **Scan works but capture fails / "failed to upload firmware":** the firmware
  blobs aren't in `~/.local/share/sigrok-firmware/`, or KingstVIS was too new
  (use 3.5.x). The FX2 `.fw` and the model's `.bitstream` must both be present.
- **`Permission denied` opening USB:** not in `plugdev`, or udev rule not
  loaded; as a stopgap run `sigrok-cli` with `sudo` (also needs the firmware in
  root's `~/.local/share` or the system dir).
