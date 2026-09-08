⚠️ **Under active development** — the label API is fairly stable, but expect rough edges.

# Dockup

Dockup is a lightweight, automated backup solution for Docker environments. Inspired by Traefik's
dynamic configuration, it uses Docker labels to discover what to back up and how — no per-service
config file, no YAML to keep in sync with your stack. Label a container, and it's backed up tonight.

Backups are stored with [Restic](https://restic.net/): deduplicated, encrypted, and pushed to any
S3-compatible bucket.

## Features

- 🔍 **Auto-discovery** — containers opt in with docker labels; nothing else to declare.
- 🐬 **MariaDB / MySQL** and 🐘 **PostgreSQL** — a native dump (`mariadb-dump` / `pg_dump`) piped
  straight into Restic, credentials read from the container's own environment.
- 🐘 **PostgreSQL on the host** — no container to label? Declare it once in the config, one database
  or the whole instance.
- 📦 **Docker volumes** — back up everything a container mounts, bind mounts and named volumes alike.
- ♻️ **Retention** — 7 daily / 4 weekly / 3 monthly snapshots kept per backup, pruned automatically.
- 🩺 **Restore** — an interactive picker: choose a backup, choose a snapshot, done.
- 🔔 **Discord reports** — a summary after every run, plus an alert if a backup goes 3 days without a
  successful snapshot (whatever the reason — a failure, or the container silently disappearing).
- 🗓️ **Unattended by default** — a systemd service + timer runs the whole thing nightly at 02:00.

## 📦 Install

Grab the binary built for your platform from the [latest release](https://github.com/arthur-eudeline/dockup/releases/latest)
and install it as `/usr/local/bin/dockup` — the path the systemd unit and `dockup upgrade` expect:

```bash
curl -fsSLo dockup https://github.com/arthur-eudeline/dockup/releases/latest/download/dockup-linux-x64
chmod +x dockup && sudo mv dockup /usr/local/bin/dockup
dockup --version
```

Assets are published for `linux-x64`, `linux-arm64`, `darwin-x64` and `darwin-arm64`, plus a
`linux-x64-baseline` build for CPUs without AVX2. Each release ships a `SHA256SUMS.txt` you can
check the download against.

**Requirements** on the host that will actually run backups: `docker`, `restic` and `bash` on
`PATH`. Volume backups use `docker run --network host`, so they need a real Docker Engine — this
does not work under Docker Desktop. Restoring/backing up a database running directly on the host
(not in a container) additionally needs `pg_dump`/`psql` — see "Databases outside docker" below.

## 🚀 Quick start

1. **Configure dockup** — S3 credentials, the Restic repository and password, a Discord webhook:

   ```bash
   dockup config init
   ```

2. **Label the containers you want backed up** — see "Labels" below.

3. **Run a backup once, by hand, to make sure everything is wired correctly:**

   ```bash
   dockup backup
   ```

4. **Install the nightly service** so it runs on its own, every day at 02:00:

   ```bash
   dockup service init
   ```

5. **Diagnose anything that looks off** at any point with:

   ```bash
   dockup config check   # alias: dockup config doctor
   ```

## 🏷️ Labels

Three labels describe how a container should be backed up — set only on the containers that opt in,
nothing needed anywhere else:

| Label                   | Required | Description                                                                                                                 |
| ----------------------- | :------: | --------------------------------------------------------------------------------------------------------------------------- |
| `dockup.backup.enabled` |   yes    | `true` to opt the container in.                                                                                             |
| `dockup.backup.name`    |   yes    | Snapshot host/tag. Keep it stable — it's how Restic groups snapshots and how dockup tracks the backup's health across runs. |
| `dockup.backup.type`    |   yes    | `mariadb`, `postgres`, or `volumes`.                                                                                        |

### MariaDB / MySQL

```yaml
mariadb:
  image: mariadb:12
  labels:
    - "dockup.backup.enabled=true"
    - "dockup.backup.type=mariadb"
    - "dockup.backup.name=my-app-db"
  environment:
    MARIADB_DATABASE: my_app
    MARIADB_USER: my_app
    MARIADB_PASSWORD_FILE: /run/secrets/db_password # or MARIADB_PASSWORD
```

Credentials are read straight from the container's own environment — nothing to duplicate in
dockup's config. `MYSQL_*` variables work as a fallback for `MARIADB_*` ones, and a `*_PASSWORD_FILE`
(Docker secret) is read in preference to a plain `*_PASSWORD`.

### PostgreSQL

```yaml
postgres:
  image: postgres:17
  labels:
    - "dockup.backup.enabled=true"
    - "dockup.backup.type=postgres"
    - "dockup.backup.name=my-app-db"
  environment:
    POSTGRES_DB: my_app
    POSTGRES_USER: my_app
    POSTGRES_PASSWORD_FILE: /run/secrets/db_password # or POSTGRES_PASSWORD
```

Same idea: `POSTGRES_USER` / `POSTGRES_DB` / `POSTGRES_PASSWORD` (or `POSTGRES_PASSWORD_FILE`) are
read from the container itself.

### Volumes

```yaml
wordpress:
  image: wordpress:latest
  labels:
    - "dockup.backup.enabled=true"
    - "dockup.backup.type=volumes"
    - "dockup.backup.name=my-wordpress"
  volumes:
    - wordpress_data:/var/www/html
```

Every bind mount and named volume attached to the container is backed up — no need to list them.

## 🐘 Databases outside docker

A postgres running on the host has no container to carry labels, so it is declared once instead:

```bash
dockup config target add     # a single database, or every database on the instance
dockup config target list
dockup config target remove
```

`add` asks which of two things the target should cover:

- **a single database** — name, host, port, user, database, password;
- **the whole instance** — same connection details, minus a specific database; instead dockup asks
  the server for every database at backup time (`select datname from pg_database where datallowconn
and not datistemplate`) and backs up each one under its own snapshot tag (`<name>-<database>`), so
  a database created after the target was declared is picked up automatically next run, without
  touching the config. Optionally exclude specific database names.

The target is probed before it is saved (for an instance target, that means connecting to every
database it currently finds), and `dockup config check` re-probes it afterwards. Each resolved
database then goes through the same nightly run, the same retention policy, the same Discord report
and the same staleness alerting as any labeled container, and shows up in `dockup restore` next to
them — one entry per database.

This needs `pg_dump` and `psql` on the host's `PATH` (the postgresql client package), at least as
recent as the server, and a `pg_hba.conf` that lets the backup user authenticate over TCP. Give it
a dedicated role rather than `postgres`; the password is stored in `/etc/dockup.conf`.

## ⏱️ Automated backups

```bash
dockup service init      # alias: setup — installs the systemd service + timer
dockup service test      # triggers the service once, to test it end to end
dockup service remove    # alias: uninstall — tears it all down
```

`service init` does everything an unattended nightly run needs, and only that: creates a dedicated
`dockup` system user (no login shell, no home directory), adds it to the `docker` group, adjusts the
config file's permissions so that user can read it, and installs a systemd service + timer that runs
`dockup backup` as that user every day at **02:00** (`Persistent=true`, so a run missed while the
machine was off still happens once it's back up). `service remove` reverses it.

Each run: discovers every labeled container and declared host target, backs each one up, prunes
snapshots down to **7 daily / 4 weekly / 3 monthly** per backup (grouped by tag — a full-scale
`prune` is not run on every invocation, keeping it fast), and posts a report to the configured
Discord webhook. If a given backup has gone **3 days** without a single successful snapshot — it
failed repeatedly, the whole run aborted before it started, or the container simply isn't there
anymore — that backup is escalated (`@everyone`) instead of quietly repeating the same red line every
night; a recovery message follows once it succeeds again. Escalations for the same backup are
throttled to once every 12 hours.

## ♻️ Restoring

```bash
dockup restore
```

Fully interactive: pick which backup to restore, pick a snapshot, confirm. A volume restore stops
the container first and restarts it once done — even if the restore itself fails or is interrupted,
so a bad restore never leaves a service down.

## 🩺 Restic passthrough

Need something dockup doesn't wrap — browsing the raw repository, checking its integrity, a manual
`forget`/`prune`? Run Restic directly, with the repository and credentials already injected:

```bash
dockup restic snapshots
dockup restic check
dockup restic forget --tag my-app-db --prune
```

## 🔐 Configuration & security

- The config lives at `/etc/dockup.conf` as encrypted JSON (`640`, owned by you and the `dockup`
  group). The encryption is **obfuscation at rest**, not a hard secret boundary — treat the file with
  the same care as any other file holding your S3 keys and database passwords.
- Credentials are always passed to child processes through the environment, never as a command-line
  argument — they never show up in `ps`, and every secret is scrubbed from logs, error messages and
  Discord payloads before they're ever printed or sent.
- `dockup config check` (alias `doctor`) is the one command to run whenever something looks wrong: it
  probes file permissions, the config's validity, docker access, the Restic repository, and every
  declared host target, and reports each independently.

## ⬆️ Update

```bash
dockup upgrade --check   # is a newer version out?
dockup upgrade           # download, verify the checksum, replace the binary in place
```

`upgrade` refuses any asset the release checksums do not vouch for, and asks for `sudo` only when
the install directory is not writable by you.

## 🛠️ Development

Contributions are welcome. The codebase is TypeScript on [Bun](https://bun.sh), built around
[Effect](https://effect.website); `docker/` holds a local compose stack (S3-compatible storage plus
labeled postgres/mariadb/wordpress containers) for exercising the tool end to end. See
[`CLAUDE.md`](./CLAUDE.md) for the full architecture rundown.

```bash
bun src/main.ts ...   # run the CLI directly, no build step
bun run check          # lint + format check
bun run build           # compile a standalone binary
```

## ⚖️ License & Warranty

This tool is distributed for free under the GNU GPL v3 License.

No Warranty
This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.

Disclaimer: The author is not responsible for any data loss, damages, or issues resulting from the use of this tool. Use it at your own risk.
