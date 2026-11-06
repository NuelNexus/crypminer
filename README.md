# Kiln

A CPU miner dashboard for [XMRig](https://github.com/xmrig/xmrig) that pays out in SOL through
[unMineable](https://unmineable.com). It comes three ways:

- **Terminal (TUI)** — `Kiln TUI.cmd` on Windows, `./kiln-tui.sh` on Linux/macOS
- **Web dashboard** — `Kiln.cmd`, then http://127.0.0.1:4545
- **Desktop app** — `cd app && npm install && npm run package` builds `dist\Kiln-win32-x64\Kiln.exe`

Only Node.js 18+ is needed for the TUI and web dashboard. The first run downloads the official
XMRig 6.26.0 release from GitHub and checks its SHA-256 before using it.

## Mining on several devices into one wallet

Every device mines to the same wallet under its own **device name** (unMineable calls this a
worker). The name defaults to the computer's name, so usually you just:

1. Install [Node.js](https://nodejs.org) on the device.
2. `git clone` this repo (or copy the folder) onto it.
3. Run `Kiln TUI.cmd` (Windows) or `./kiln-tui.sh` (Linux/macOS) and press **s** to start.

To pick the name or wallet yourself:

```
node app/tui.js --worker desktop
node app/tui.js --worker desktop --address <your Solana address>
```

You can also press **w** in the TUI to rename the device. Names must be unique per device.

### The Devices table

The TUI shows every device mining to the wallet, from any machine:

| Column | Meaning |
| --- | --- |
| Hashrate | Speed the pool currently sees from that device |
| Share | That device's share of all hashes Kiln has recorded for the wallet |
| Est / day | What that device earns per day at its current speed |
| Earned 24h / total | The wallet's real earnings, split by share |

unMineable only reports earnings for the wallet as a whole, so per-device earnings are an
estimate: Kiln records each device's hashrate from the pool every 90 seconds while it is open
and splits the wallet total by those hashes. The wallet totals themselves come straight from the
pool. Hashes are only recorded while some copy of Kiln is open; each device keeps its own record
in `data/fleet.json`.

## TUI keys

| Key | Action |
| --- | --- |
| s | start / stop mining |
| m | switch between balanced and max mode |
| + / - | more / fewer threads, 0 for the recommended count |
| t | auto-tune (tries several thread counts and keeps the fastest) |
| w | rename this device |
| d | open the web dashboard |
| q | quit |

If the desktop app or `Kiln.cmd` is already running, the TUI attaches to it and quitting leaves
mining running. Otherwise the TUI runs the miner itself and quitting stops it.

## Performance

Run as administrator (Windows) or with `sudo` (Linux) so XMRig can enable huge pages and the MSR
prefetcher tweak. `Kiln - max performance.cmd` does this for the web dashboard.

Windows Defender often flags XMRig. If it does, add a folder exclusion for this folder.

## Settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `KILN_PORT` | 4545 | Port for the dashboard and API |
| `KILN_ROOT` | repo folder | Where `data/` and XMRig live |
