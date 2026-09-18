## dockup@0.8.0

### Features

- Allow partial override (807fd78)

## dockup@0.7.0

### Features

- Improve discord webhook content (f71099d)

### Bug fixes

- Restic retry lock (c512ebc)

## dockup@0.6.0

### Features

- Restauration ownership (28cf4bc)
- Restaure avec user role (12320f0)

## dockup@0.5.0

### Features

- Backup all database (86ea48a)
- Support clickhouse (7e0ea8a)
- Improve dockup doctor (61a9502)

## dockup@0.4.0

### Features

- Improve prompts labels (b78bbb1)
- Restore to target (1f8d7c7)
- Stream lines (18e70b2)
- Streaming progression on restore (001d97c)

## dockup@0.3.0

### Features

- Init non-interactive (5801722)

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
