⚠️ **Under active development**

# Dockup

Dockup is a lightweight, automated backup solution designed for Docker environments. Inspired by Traefik’s dynamic configuration, Dockup uses Docker Labels to automatically discover and back up your services using the power of Restic.
Stop manually configuring backup jobs. Just label your containers, and Dockup handles the rest.

## Features

- 🔍 Auto-Discovery: Automatically detects running containers via Docker labels (no static config files needed).
- 🛡️ Restic Powered: Benefit from deduplication, encryption, and multi-backend support (only S3 is supported at the moment).
- ⚡ Zero-Config Deployment: Deploy Dockup as a single container and let it watch your cluster.
- 🗓️ scheduled Cron Support: Define backup intervals globally or per-container.
- 💾 Volume & Database Support: Designed to back up persistent data safely.

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

## ⬆️ Update

```bash
dockup upgrade --check   # is a newer version out?
dockup upgrade           # download, verify the checksum, replace the binary in place
```

`upgrade` refuses any asset the release checksums do not vouch for, and asks for `sudo` only when
the install directory is not writable by you.

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

## ⚖️ License & Warranty

This tool is distributed for free under the GNU GPL v3 License.

No Warranty
This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.

Disclaimer: The author is not responsible for any data loss, damages, or issues resulting from the use of this tool. Use it at your own risk.
