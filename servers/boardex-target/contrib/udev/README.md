# udev rules for Boardex debug probes (Linux)

Linux blocks raw USB access to debug probes for unprivileged users by
default. `49-boardex-probes.rules` grants it for the probes the pyOCD backend
supports today (ST-Link V2/V2-1/V3, generic CMSIS-DAP).

```bash
sudo cp 49-boardex-probes.rules /etc/udev/rules.d/
sudo udevadm control --reload && sudo udevadm trigger
# re-plug the probe
```

Logic analyzers are NOT covered here: libsigrok ships its own
`60-libsigrok.rules` (and KingstVIS provides `99-Kingst.rules`) — see
`docs/kingst-la-bringup.md` for the Kingst LA flow.

Run `boardex-doctor` to verify: the `usb-access (linux)` check reports which
rule files it found.

We deliberately ship rule files only — never kernel drivers or vendor
firmware. See `docs/SUPPORT_MATRIX.md` for the per-OS driver story.
