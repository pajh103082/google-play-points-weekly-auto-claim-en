# Google Play Points Weekly Prize Auto Claim (Chrome extension)

Automatically claims the **Google Play Points weekly prize** for **every Google account signed in to Chrome**, using the [Play Points website](https://play.google.com/store/points/perks). No phone or emulator needed, and no passwords are stored.

> 中文版 / Traditional Chinese version: [google-play-points-weekly-auto-claim](https://github.com/pajh103082/google-play-points-weekly-auto-claim)

<p align="center"><img src="icons/icon128.png" width="96" alt="icon"></p>

## Features

- **Multiple accounts**: switches between the Google accounts signed in to Chrome with `authuser=0, 1, 2…` and handles all of them
- **Retries all week**: from Friday 00:05 through the next Thursday it checks every 2 hours while any account is still pending
- **Catches up when Chrome starts**: missed it because the PC or Chrome was off? It runs as soon as Chrome opens
- **Skips what is already claimed**: a grey button whose "Available on …" date is still in the future means this week's prize is already claimed, so no page is opened again
- **Knows "not available yet"**: the date has arrived but the button is still grey → tries again 2 hours later
- **Skips accounts that can never get a prize**: not a Play Points member, or the Perks tab says "Your unlocked perks will show up here as you level up". These are not failures, so their page is not opened every time; the result carries over to the next week and they are re-checked automatically every 4 weeks (in case the account joins or earns points later)
- Runs in a background tab that closes itself; shows a Windows notification when something is claimed or needs attention
- Toolbar badge shows how many accounts are still pending; ✓ when everything is done

## What's included

| Part | Required? | What it does |
|---|---|---|
| Chrome extension (files in the root folder) | ✅ Required | The part that actually claims the weekly prize |
| [`boot-launcher/`](#optional-open-chrome-at-windows-startup) | Optional | At Windows sign-in, opens Chrome only if this week is not handled yet |

## Install the extension

1. Download this project (green **Code** button → **Download ZIP**) and unzip it
2. Open `chrome://extensions` in Chrome
3. Turn on **Developer mode** (top right)
4. Click **Load unpacked** and choose the unzipped folder (the one that contains `manifest.json`)
5. Click the puzzle icon in the toolbar → pin "Google Play Weekly Prize"
6. Click the icon → **Check & claim now** to run it once and see each account's status

Requirement: this Chrome is signed in to the Google account(s) you want to claim for (several accounts are fine).

## Popup

- How many accounts are done this week, each account's status, recent activity
- **Only these accounts**: enter email addresses (comma or new line separated) to limit which accounts are handled; empty = all
- **Support me on Ko-fi** button

## Status meanings

| Status | Meaning |
|---|---|
| ✅ Claimed | Clicked Claim, reloaded, and the button turned grey → success |
| ☑ Already claimed | The button is grey and the "Available on …" date is still in the future (waiting for the next prize) |
| ⏳ Not available yet | The date has arrived but the button is still grey; tries again in 2 hours |
| … not checked this week | A new week started and this account has not been checked yet |
| – No weekly prize | The Perks tab says "Your unlocked perks will show up here as you level up": this account cannot get a prize; its page is not opened again, re-checked every 4 weeks |
| – Not a Play Points member | Only "Join for free" is shown: same as above |
| ⚠ Website cannot claim, use the app | Google asks you to claim in the Play Store app on Android |
| ⚠ Clicked Claim, not confirmed / not found | Tries again in 2 hours; if it keeps happening the website may have changed |

## Optional: open Chrome at Windows startup

The [`boot-launcher`](boot-launcher/) folder is a small Windows tool that you **may or may not install**.

**What it does:** the extension only runs while Chrome is open. This tool runs every time you sign in to Windows and **first checks whether this week's weekly prizes are already handled**:
- Not handled yet → opens Chrome with the profile you chose (minimized by default) so the extension can claim
- Already handled → **does not open Chrome**, so it won't bother you
- The same Chrome profile is already open → does not open another window

### With vs. without the startup launcher

| | Without (extension only) | With the startup launcher |
|---|---|---|
| Are weekly prizes claimed automatically? | ✅ Yes, whenever Chrome is open | ✅ Yes |
| Do you need to open Chrome yourself after booting? | Yes; once Chrome opens, the extension catches up | No; it opens Chrome for you if anything is pending |
| Does Chrome pop up at startup when everything is claimed? | No (nothing opens Chrome automatically) | No (it sees everything is handled and skips) |
| Best for | People who open Chrome every day anyway | People who often go days without opening Chrome and don't want to miss a prize |
| Setup | None | Double-click 3 files (steps below) |
| What it changes on your PC | Nothing | Adds one shortcut to the Windows Startup folder (remove it any time) |

### Setup (double-click in this order)

| File | What it does |
|---|---|
| `1_select_chrome_profile.bat` | Lists every Chrome profile on this PC; type the number of **the one with this extension installed** |
| `2_test_open.bat` | Opens Chrome once with that profile so you can confirm it is the right one |
| `5_check_status.bat` | Only shows this week's status and whether Chrome would be opened at startup; does not open Chrome |
| `3_install_startup.bat` | Creates a shortcut in the Windows Startup folder so it runs at every sign-in |
| `4_remove_startup.bat` | Removes that shortcut if you no longer want it |

Settings are in `boot-launcher/settings.txt`:

| Setting | Default | Meaning |
|---|---|---|
| `account=` | (empty) | Which Chrome profile to open; filled in automatically by `1_select_chrome_profile.bat` |
| `window=` | `minimized` | `minimized` = start minimized to the taskbar; `normal` = normal window |
| `delay_seconds=` | `30` | Seconds to wait after sign-in before deciding (lets the network connect) |
| `skip_if_done=` | `yes` | Set to `no` to open Chrome at every startup |

The launcher writes what it did to `boot-launcher/startup.log`.

### How it knows whether this week is done

The extension writes "is this week handled?" to `Downloads\ChromeExtensionStatus\google_play_weekly.json`:

```json
{ "week": "2026-11-20", "allDone": true, "accounts": 6, "pending": 0, "updated": "2026-11-20 00:07" }
```

`week` is the most recent Friday. You can change where it is saved with `statusDir` in the extension's `status_config.json` (a path relative to Chrome's download folder). For example, if the extension is in `Downloads\tools\gplay`, set `"statusDir": "tools/gplay"` to keep the status file inside the extension folder; the startup launcher reads the same setting. The download bar is turned off while the file is saved and the entry is removed from the download history, so you won't see a download prompt. If you don't use the startup launcher, this small file does no harm.

> The startup launcher only reads Chrome's profile list and this status file on your own PC. It does not connect to the internet and does not read your passwords or cookies.

## Permissions

| Permission | Why |
|---|---|
| `https://play.google.com/*` | Open the Play Points Perks page, read the weekly prize button and click it |
| `tabs`, `scripting` | Open a background tab and run the check inside the page |
| `alarms` | Wake up every 30 minutes to see whether a run is needed |
| `storage` | Remember each account's status for this week |
| `notifications` | Tell you when something is claimed or needs attention |
| `downloads`, `downloads.ui` | Save the status file above (and hide the download prompt while saving) |

Your passwords, cookies and data are never read or sent to any outside server.

## Notes

- It works by reading text and buttons on the Play Points website (opened in English), so a website redesign may need an update. Traditional Chinese text is recognised as a fallback.
- Chrome must be open for the extension to run.
- Using automation tools may not comply with Google Play's terms of service; use at your own risk.
- Not affiliated with or endorsed by Google. Google Play is a trademark of Google LLC.

## Support

If this saves you time, you can buy me a coffee ☕ → [ko-fi.com/sagiriben](https://ko-fi.com/sagiriben)
