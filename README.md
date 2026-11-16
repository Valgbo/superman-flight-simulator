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

On a touchscreen, use the **left joystick** for analog forward/backward movement and strafing. Drag the sky with another finger to steer while moving. Hold **Up** or **Down** to change altitude; **Hover** brakes and switches off turbo and hyperspeed. Releasing the joystick returns it to neutral. Controls reset when touch is interrupted, the screen rotates, or the game pauses.

Touch controls appear automatically on devices with a coarse pointer and can be toggled in settings. The touch layout reserves room for the joystick, altitude controls, navigation, and power buttons in portrait and landscape, including display safe areas. Touch mode caps rendering resolution to reduce GPU load; the Performance graphics setting further reduces detail.

## Flight rules

- Atmospheric flight is capped at Mach 2, using 343 m/s as the reference speed of sound.
- Turbo breaks skyscrapers along your flight path. Ordinary collisions stop flight.
- Space unlocks at 12,000 scene metres. Altitude and solar-system distances are compressed for playable travel times.
- Hyperspeed is available in space. Approaching the Sun slows flight so you can enter its corona and charge solar power.

This is a game simulation rather than a physically accurate model of Earth or the solar system. It is an unofficial fan project and is not affiliated with DC or Warner Bros.

## City graphics

The skyline mixes glass towers, offset modern blocks, and stepped stone buildings. Shared facade textures keep floors at a consistent scale, with window lighting, surface detail, and static environment reflections. The Daily Planet has a detailed globe, gold trim, and signs on all four sides.

Tower geometry is merged by material. Rooftop equipment appears nearby, with a shorter detail distance and reduced surface effects in Performance mode. Windows use textures rather than individual meshes, and debris remains pooled.

## Checks and production build

```sh
npm test
npm run build
npm run preview
```

The production files are generated in `dist/`. Vite uses relative asset URLs so the build can be hosted under a repository subpath. GitHub Actions runs the tests and production build for pushes and pull requests.

## GitHub Pages deployment

The **Deploy to GitHub Pages** workflow publishes `dist/` after tests and a production build. It runs automatically on pushes to `main` and can also be run manually, matching the deployment used by the Flying Aircraft Carrier site.

1. Open the repository's **Settings → Pages** and set **Source** to **GitHub Actions**.
2. Open **Actions → Deploy to GitHub Pages → Run workflow**.
3. Select `main`, run it, and open the deployment URL shown by the `github-pages` environment. Later pushes to `main` deploy automatically.

After Pages is enabled and the workflow succeeds, the game is served at https://valgbo.github.io/superman-flight-simulator/.

Pages for a private repository may require an eligible GitHub plan. Check the Pages audience before deploying: a private repository can produce a publicly accessible Pages site, depending on account settings.

## Source layout

`src/flight.ts` contains flight state and movement rules, `src/world.ts` creates the city and space scenery, and `src/hero.ts` animates the procedural character. `src/touch-controls.ts` handles independent touch pointers, with joystick math in `src/joystick-math.ts` and the touch layout in `src/touch.css`. Meaningful flight, collision, joystick, and building-geometry checks live in `tests/`.
