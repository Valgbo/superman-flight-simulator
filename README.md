# Superman Flight Simulator

A fan-made browser flight sandbox built with TypeScript, Three.js, and Vite. Fly around a procedural Metropolis, smash through skyscrapers in turbo mode, climb into space, and follow the Sun marker at hyperspeed.

## Play locally

Use Node.js 22 or later.

```sh
npm ci
npm run dev
```

Open the local URL printed by Vite. A browser with WebGL 2 support is required.

## Controls

| Control | Action |
| --- | --- |
| W / S | Throttle / brake |
| A / D | Strafe left / right |
| Mouse drag or captured mouse | Steer |
| Arrow keys | Steer with the keyboard |
| Space / Ctrl | Ascend / descend |
| Shift or Turbo button | Turbo flight and building destruction |
| H or Hyperspeed button | Toggle hyperspeed in space |
| Escape | Pause |

The navigation buttons assist travel to orbit and the Sun. Return to Metropolis and reset the city using the on-screen controls. Settings are stored locally in your browser.

## Flight rules

- Atmospheric flight is capped at Mach 2, using 343 m/s as the reference speed of sound.
- Turbo breaks skyscrapers along your flight path. Ordinary collisions stop flight.
- Space unlocks at 12,000 scene metres. Altitude and solar-system distances are compressed for playable travel times.
- Hyperspeed is available in space. Approaching the Sun slows flight so you can enter its corona and charge solar power.

This is a game simulation rather than a physically accurate model of Earth or the solar system. It is an unofficial fan project and is not affiliated with DC or Warner Bros.

## Checks and production build

```sh
npm test
npm run build
npm run preview
```

The production files are generated in `dist/`. Vite uses relative asset URLs so the build can be hosted under a repository subpath. GitHub Actions runs the tests and production build for pushes and pull requests.

## Optional GitHub Pages deployment

Publishing is manual. The repository includes a **Deploy to GitHub Pages** workflow, but pushing code does not publish the game.

1. Open the repository's **Settings → Pages** and set **Source** to **GitHub Actions**.
2. Open **Actions → Deploy to GitHub Pages → Run workflow**.
3. Select the branch containing the game, run it, and open the deployment URL shown by the `github-pages` environment.

Pages for a private repository may require an eligible GitHub plan. Check the Pages audience before deploying: a private repository can produce a publicly accessible Pages site, depending on account settings.

## Source layout

`src/flight.ts` contains flight state and movement rules, `src/world.ts` creates the city and space scenery, and `src/hero.ts` animates the procedural character. The remaining application code connects rendering, input, sound, and the HUD. Meaningful flight and collision checks live in `tests/`.
