# Auto Sim

Runs all three alliance robots' autos at the same time and shows where they collide. Made by FRC Team 3647, the Millennium Falcons.

## Use it

1. Open `index.html` in a browser, or go to the hosted site.
2. Drop each team's auto files on a robot. You can drop single files or a whole `deploy` folder.
   - PathPlanner: `.auto`, `.path` and `settings.json` (for bumper size)
   - Choreo: `.traj` and `.chor` (for bumper size)
3. Pick each robot's auto and press play. Red markers show where robots hit; click one to jump to it.

**Work together live:** click **Start live session** and send the other teams the 4-character code (or **Copy invite link**). They open the site on their own laptop, click **Join session**, and load their own robot. Everyone sees the same three robots. No accounts needed. The devices connect directly to each other through the free PeerJS service, so the session lasts as long as the device that started it keeps the page open. Some school or event Wi-Fi networks block these direct connections; a phone hotspot usually works.

**Share an alliance file:** click **Save alliance file** and send the `.autosim` file to the other teams. They open it with **Open alliance file**.

## Put it online (free, no sign-in)

1. Create a public repo on github.com and push this folder to it.
2. In the repo, go to **Settings → Pages** and deploy from branch `main`, folder `/ (root)`.
3. The site is live at `https://<user>.github.io/<repo>/` a minute later.

## Accuracy

Choreo trajectories are replayed exactly. PathPlanner only stores curves, so the timing is worked out from each path's speed and acceleration limits. It's close to PathPlanner's preview but not exact. Named commands (like `shoot`) are treated as instant.

## Credits

Field images in `fields/`: 2024 and 2026 are from AdvantageScope's field assets (top-down renders shared on Chief Delphi), and 2025 is the official WPILib field image.
