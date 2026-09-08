## dockup@0.2.0

### Features

- Système d'upgrade (06e4ca4)

### Bug fixes

- **report, restic, backup:** Silent-failure cleanups in reporting and preflight (8d20999)
- **service:** Make the install path work, and fix the inverted usermod (d0d4688)
- **config:** Make ensureWritePermission actually fail, and test the right dir (dcc01cb)
- **docker:** Isolate unreadable containers instead of failing discovery (e423ac6)
- **shell:** Pipefail, quoting and secret containment in every command (e4fe849)
- **backup:** Read MARIADB_PASSWORD as a value, not a file path (ead098d)
