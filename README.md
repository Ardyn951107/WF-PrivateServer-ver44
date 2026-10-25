# Warframe Private Server

A custom, self-hosted build of [SpaceNinjaServer](https://about.openwf.io/), the community preservation project for Warframe's web services. This project specifically targets Warframe version **44.1.1**. Run it on your own machine or private network and tailor the server settings to your preferences.

> This is an unofficial community project and is not affiliated with or endorsed by Digital Extremes. Keep your server private and only connect clients you are authorized to use.

## What you can customize

- Server behavior through `config.json`, including account defaults and WebUI permissions.
- World-state settings such as Plains of Eidolon time, Orb Vallis temperature, Duviri spiral, and Fissures.
- The server's database: use the included embedded MongoDB setup or connect to an existing MongoDB instance.
- Optional IRC and hub services, when you have those services available.

## Get started

### Requirements

- Node.js matching the version specified in [`.nvmrc`](.nvmrc)
- npm
- MongoDB, if you choose to use an external database instead of the default embedded database

### Install and run

1. Clone or download this repository.
2. Install dependencies:

   ```sh
   npm ci
   ```

3. Create your local configuration by copying `config-vanilla.json` to `config.json`. The vanilla config is a baseline with most cheats disabled.
4. Edit `config.json` as needed. In particular, set `skipTutorial` before creating your first account if you want new accounts to skip the tutorial.
5. Build and start the server:

   ```sh
   npm run build
   npm start
   ```

The server reads `config.json` from the project directory. Keep your local configuration and database backed up; they contain your server settings and account data.

### Docker

The included Compose file uses the published `openwf/spaceninjaserver` image by default. To build and run this checkout instead, edit `docker-compose.yml`: comment out the `image` line and uncomment `build: .`, then run:

```sh
docker compose up --build
```

Compose persists configuration, logs, static data, and MongoDB data under `docker-data/`. The container listens on ports 80 and 443; change the left-hand side of the port mappings in `docker-compose.yml` if those ports are already in use.

## Keep your server private

The vanilla configuration enables the WebUI and allows non-admin users several account-management actions. Review `webui.adminOnly` and `webui.nonAdminPermissions` in `config.json` before allowing other people to connect. Avoid exposing the server or its WebUI to the public internet unless you have deliberately secured and configured it.

## Configuration guide

All settings live in `config.json`. Start with `config-vanilla.json`; configuration keys and defaults can change between server versions.

| Setting | Purpose |
| --- | --- |
| `database` | Defaults to an embedded MongoDB database. It can instead be a MongoDB connection string, for example `"mongodb://127.0.0.1:27017/openWF"`. |
| `skipTutorial` | Applies to newly created accounts. Set it before first login if you want the tutorial skipped. |
| `bindAddress`, `httpPort`, `httpsPort` | Control how the server listens for connections. In Docker, configure the published ports in `docker-compose.yml` instead. |
| `ircExecutable`, `hubExecutable` | Optional paths to IRC and hub executables; relative paths are resolved by the server process. |
| `ircAddress`, `hubServers`, `nrsAddresses` | Configure addresses advertised to clients for those secondary services. A `null` `ircAddress` is equivalent to `%THIS_MACHINE%`, which is suitable when the server and IRC service are on the same machine. |
| `logger.fileLevel`, `logger.consoleLevel` | Set the minimum output level independently for file and console logs: `error`, `warn`, `info`, `http`, `debug`, or `trace`. |

### World-state overrides

Set these under `worldState` in `config.json`:

| Setting | Accepted values / effect |
| --- | --- |
| `eidolonOverride` | `day` or `night` to lock Plains of Eidolon to day/fass or night/vome on the Cambion Drift. |
| `vallisOverride` | `warm` or `cold` to lock Orb Vallis temperature. |
| `duviriOverride` | `joy`, `anger`, `envy`, `sorrow`, or `fear` to lock the Duviri spiral. |
| `nightwaveOverride` | Locks the Nightwave season, if supported by the client. See the season values below. |
| `allTheFissures` | `normal` or `hard` to enable all Fissures on the normal Star Chart or Steel Path. |
| `circuitGameModes` | An array that sets The Circuit rotation instead of using the random pattern. Values: `Survival`, `VoidFlood`, `Excavation`, `Defense`, `Exterminate`, `Assassination`, and `Alchemy`. |

<details>
<summary>Nightwave season values</summary>

Set `worldState.nightwaveOverride` to one of these values:

| Value | Season |
| --- | --- |
| `RadioLegionIntermission16Syndicate` | Amir's Shockwave |
| `RadioLegionIntermission15Syndicate` | Nora's Mix: Time Tempests |
| `RadioLegionIntermission14Syndicate` | Nora's Mix: Dreams of the Dead |
| `RadioLegionIntermission13Syndicate` | Nora's Mix Vol. 9 |
| `RadioLegionIntermission12Syndicate` | Nora's Mix Vol. 8 |
| `RadioLegionIntermission11Syndicate` | Nora's Mix Vol. 7 |
| `RadioLegionIntermission10Syndicate` | Nora's Mix Vol. 6 |
| `RadioLegionIntermission9Syndicate` | Nora's Mix Vol. 5 |
| `RadioLegionIntermission8Syndicate` | Nora's Mix Vol. 4 |
| `RadioLegionIntermission7Syndicate` | Nora's Mix Vol. 3 |
| `RadioLegionIntermission6Syndicate` | Nora's Mix Vol. 2 |
| `RadioLegionIntermission5Syndicate` | Nora's Mix Vol. 1 |
| `RadioLegionIntermission4Syndicate` | Nora's Choice |
| `RadioLegionIntermission3Syndicate` | Intermission III |
| `RadioLegion3Syndicate` | Glassmaker |
| `RadioLegionIntermission2Syndicate` | Intermission II |
| `RadioLegion2Syndicate` | The Emissary |
| `RadioLegionIntermissionSyndicate` | Intermission I |
| `RadioLegionSyndicate` | The Wolf of Saturn Six |

</details>

## Credits

This project builds on the [OpenWF SpaceNinjaServer preservation project](https://about.openwf.io/). Visit the [OpenWF website](https://about.openwf.io/) or join the [OpenWF Discord](https://discord.gg/PNNZ3asUuY) for upstream project information.
