# OpenFront Spawn Heatmap Overlay

A Chrome extension that overlays [ofstats.io](https://ofstats.io) spawn heatmaps directly onto [openfront.io](https://openfront.io), so you can see the best (and worst) spots to spawn without leaving the game.

- Blue = worse than expected win rate, red = better, white = as expected.
- Updates automatically as you pick a map (hosting) or join someone's lobby.
- Draggable, resizable, collapsible.

## Setup (Chrome)

This isn't on the Chrome Web Store, so it's loaded as an "unpacked" extension — takes about a minute.

1. **Download the extension folder.**
   - If you got this as a zip, unzip it anywhere.
   - If you're cloning the repo: `git clone` it, you just need the `extension/` folder.
2. Open `chrome://extensions` in Chrome (paste that into the address bar).
3. Turn on **Developer mode** (toggle, top-right corner).
4. Click **Load unpacked**.
5. Select the `extension` folder (the one with `manifest.json` in it).
6. Done — go to [openfront.io](https://openfront.io) and host or join a lobby. The heatmap panel appears top-right automatically once a map is selected.

## Updating

If you get a newer version of the extension, replace the `extension` folder with the new files, then go back to `chrome://extensions` and click the reload icon (⟳) on the extension's card. The version number on the card (e.g. `0.2.1`) tells you which build you're on.

## Usage

- **Drag** the panel by its header to move it anywhere on screen.
- **Resize** by dragging the bottom-right corner.
- **Collapse** with the `–`/`+` button in the header.
- The heatmap updates whenever the selected/joined map changes.
