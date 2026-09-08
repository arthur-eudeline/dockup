# Audit de qualité et de bugs — dockup

> Audit réalisé le 2026-09-08 sur la branche `effect-command-migration` (commit `6146bdf`).
> Périmètre : l'intégralité de `src/` (26 fichiers, 2 634 lignes).
> État des gates : `tsc --noEmit` passe ; `bun run check` échoue sur 2 fichiers (formatage).
>
> Les hypothèses douteuses sur le comportement de Bun Shell, d'Effect et de zod ont été
> vérifiées empiriquement ; les résultats de ces vérifications sont cités dans chaque section.

## Sommaire

| #   | Sévérité    | Titre                                                                     | Emplacement                   |
| --- | ----------- | ------------------------------------------------------------------------- | ----------------------------- |
| 1   | ✅ Corrigé  | Aucun `pipefail` : un dump raté produit un snapshot vide « réussi »       | `src/lib/backup.ts:80,166`    |
| 2   | ✅ Corrigé  | `MARIADB_PASSWORD` lu comme un fichier → backup MariaDB cassé             | `src/lib/backup.ts:45`        |
| 3   | ✅ Corrigé  | Un seul conteneur mal labellisé bloque toutes les sauvegardes             | `src/lib/docker.ts:116`       |
| 4   | ✅ Corrigé  | Fuite de secrets dans les messages d'erreur → console et Discord          | `src/lib/utils.ts:50`         |
| 5   | ✅ Corrigé  | `usermod` avec les arguments inversés                                     | `src/lib/config.ts:135`       |
| 6   | ✅ Corrigé  | Aucun échappement shell — injection depuis l'environnement des conteneurs | `src/lib/utils.ts:17,42`      |
| 7   | ✅ Corrigé  | `service init` ne peut pas fonctionner tel quel                           | `src/lib/service.ts:16,22,61` |
| 8   | ✅ Corrigé  | `ensureWritePermission` ne peut jamais échouer                            | `src/lib/utils.ts:142`        |
| 9   | ✅ Corrigé  | `$localhost` parasite dans les URI Postgres                               | `src/lib/backup.ts:166,192`   |
| 10  | ✅ Corrigé  | `host.docker.internal` avec `--network host` ne résout pas sous Linux     | `src/lib/docker.ts:199`       |
| 11  | 🟡 Bug      | Message Discord vide                                                      | `src/lib/discord.ts:35`       |
| 12  | ✅ Corrigé  | `.env()` remplace tout l'environnement — plus de `PATH`, plus de `HOME`   | `src/lib/utils.ts:42`         |
| 13  | 🟡 Bug      | `ensureRepoInitialized` confond « lent » et « non initialisé »            | `src/lib/restic.ts:288`       |
| 14  | ✅ Corrigé  | `jounalctl`                                                               | `src/lib/service.ts:74`       |
| 15  | 🟡 Bug      | `backup` ne vérifie ni les droits Docker ni l'état du dépôt               | `src/commands/backup.cmd.ts`  |
| 16  | 🔵 Qualité  | Code mort, tags Effect, validations sans effet, divers                    | —                             |

---

## 🔴 Critiques — perte ou corruption silencieuse de sauvegarde

### 1. ✅ Aucun `pipefail` : un dump raté produit un snapshot vide « réussi »

> **Corrigé.** `getShellOutput` et `streamShellOutput` (`src/lib/utils.ts`) n'utilisent plus le
> shell intégré de Bun mais `bash -o pipefail -c <cmd>` : l'échec du membre gauche d'un pipe fait
> désormais échouer toute la commande. Vérifié : `false | cat` → exit 1 (contre 0 avant), et
> `streamShellOutput({cmd: "false | cat"})` remonte bien un `ShellCommandFailureError`.
>
> Deuxième ligne de défense pour le cas « le dump sort en 0 sans rien écrire » : le schéma de
> sortie restic lit maintenant `total_bytes_processed`, et `parseResticBackupOutput(…, {
> rejectEmpty: true })` — activé sur les deux dumps `--stdin` — échoue avec un
> `EmptyBackupError` si restic a traité 0 octet. Un snapshot vide ne peut plus être rapporté
> comme un backup réussi.
>
> Côté restore, `psql` reçoit `-v ON_ERROR_STOP=1` : sans ça il sortait en 0 même si toutes
> les instructions du dump échouaient, et dockup affichait « Snapshot restored. ».

**Emplacement :** `src/lib/backup.ts:80`, `:166` (et symétriquement `:111`, `:192`)

```
docker exec … mariadb-dump … | restic backup --stdin …
```

Bun Shell ne fait **pas** `set -o pipefail` — vérifié :

```
exitCode de 'false | cat'      → 0
exitCode de 'exit 3 | wc -c'   → 0
```

Donc si `mariadb-dump`/`pg_dump` échoue (mauvais mot de passe, DB down, OOM),
`restic backup --stdin` reçoit 0 octet, crée un snapshot **vide**, sort en 0, et dockup
rapporte `🟢 backuped` sur Discord. C'est le pire mode de défaillance possible pour un outil
de backup : la panne n'est découverte qu'au restore. Même chose au restore
(`restic dump | psql` : dump vide → psql OK → « Snapshot restored. »).

**Correctif :** exécuter le dump et le `restic backup` en deux étapes chaînées explicitement
(vérifier le code de sortie du dump), ou passer par `bash -c 'set -o pipefail; …'` plutôt que
par le shell intégré de Bun.

### 2. ✅ `MARIADB_PASSWORD` est lu comme un fichier → backup MariaDB cassé sans Docker secrets

> **Corrigé.** Le flag `file` a été retiré de la lecture de `MARIADB_PASSWORD`/`MYSQL_PASSWORD`.
> Au passage, les `Effect.catchAll(() => null)` des deux résolutions de mot de passe (mariadb _et_
> postgres) ont été resserrés en `Effect.catchTag("UNDEFINED_VARIABLE_ERROR", …)` : seule une
> variable _absente_ déclenche le repli, un échec de lecture du fichier de secret remonte
> désormais au lieu d'être confondu avec « pas de fichier de secret ».

**Emplacement :** `src/lib/backup.ts:45`

```ts
const password = yield* getContainerEnvVariable(containerId, vars, "MARIADB_PASSWORD", true);
//                                                                                     ^^^^ file = true
```

Le 4ᵉ argument `file` déclenche `docker exec <id> cat <valeur>` — ici on `cat` le mot de passe
lui-même. Ça échoue, le `Effect.catchAll(() => null)` ligne 49 avale l'erreur, `password` vaut
`null`, et on tombe sur `UndefinedVariableError` ligne 53. **Tout conteneur MariaDB qui utilise
`MARIADB_PASSWORD`/`MYSQL_PASSWORD` (et non `*_PASSWORD_FILE`) n'est jamais sauvegardé.**

La version Postgres (`:131`) est correcte, elle n'a pas le `true` — l'asymétrie confirme la
faute de frappe.

### 3. ✅ Un seul conteneur mal labellisé bloque **toutes** les sauvegardes

> **Corrigé.** `listBackupEnabledContainers` utilise `Effect.partition` et renvoie désormais
> `{ containers, invalid }` : les conteneurs illisibles sont mis de côté au lieu de faire
> échouer la découverte entière. `backup` les journalise et les inscrit dans le rapport Discord
> comme des échecs individuels (ils ne disparaissent donc pas silencieusement), et `restore` les
> signale en warning avant de proposer la liste des conteneurs restaurables.
>
> Au passage, `ContainerBackupInfosParsingError` sort de la signature — il n'était jamais
> construit (cf. §16).

**Emplacement :** `src/lib/docker.ts:116-119`

```ts
const containersInfos = yield* Effect.all(containerIds.map(getContainerBackupConfig), { concurrency: "unbounded" });
```

`Effect.all` est fail-fast. Un conteneur avec `dockup.backup.enabled=true` mais un
`dockup.backup.name` manquant ou un `type` inconnu fait échouer la découverte entière →
`backup.cmd.ts:78` remonte l'erreur, un message Discord, et **aucun conteneur** n'est
sauvegardé cette nuit-là.

**Correctif :** utiliser `Effect.partition` (ou `Effect.either` par élément) pour isoler les
conteneurs invalides et continuer avec les autres, en les listant dans le rapport.

---

## 🟠 Sécurité

### 4. ✅ Fuite de secrets dans les messages d'erreur → console **et webhook Discord**

> **Corrigé**, sur deux fronts.
>
> 1. **Les secrets ne sont plus dans les commandes.** `formatResticConfigToEnvArgs` n'émet plus
>    que `-e AWS_ACCESS_KEY_ID -e …` sans valeur : `docker run -e NAME` fait hériter la valeur de
>    l'environnement du client, que l'appelant passe désormais via `env`. Le mot de passe MariaDB
>    passe par `MYSQL_PWD` et celui de Postgres par `PGPASSWORD` au lieu de `--password=` et de
>    l'URI `postgresql://user:pass@…`. Plus rien de sensible dans `ps aux` ni dans la ligne de
>    commande citée par une erreur. (Vérifié : `docker exec -e PGPASSWORD` récupère bien la
>    valeur depuis l'environnement du client.)
> 2. **Filet de sécurité : `src/lib/redact.ts`.** Chaque secret manipulé (clé S3, mot de passe
>    restic, mot de passe de conteneur) est enregistré dès sa résolution, et `redact()` le
>    remplace par `***` dans tout message d'erreur construit et dans chaque ligne de sortie
>    streamée. La rédaction se fait par **valeur exacte**, pas par motif : elle attrape la fuite
>    quelle que soit sa forme (ligne de commande, URI, dump de stderr restic) sans deviner.
>    Vérifié : un secret imprimé par une commande qui échoue ressort en `***` dans le `_tag` +
>    `message` rendu (le seul contenu envoyé à Discord) comme dans les lignes de log.

**Emplacement :** `src/lib/utils.ts:50-52` → `src/lib/docker.ts:193-201` → `src/commands/backup.cmd.ts:57-64`

`streamShellOutput` construit `The command ${args.cmd} failed`. Or `args.cmd` contient en clair :

- pour `backupVolumes` : `-e AWS_SECRET_ACCESS_KEY=… -e RESTIC_PASSWORD=…`
  (via `formatResticConfigToEnvArgs`) ;
- pour `backupPostgres` : `postgresql://user:MOTDEPASSE@…`.

Ce `e.message` est repris tel quel dans la ligne de rapport (`message: e.message`) puis posté
sur le webhook Discord. **Un échec de backup publie vos clés S3 et le mot de passe restic dans
un salon Discord.**

**Correctif :** rédiger systématiquement (`***`) la commande avant de la mettre dans le message
d'erreur, et ne jamais exposer `e.message` brut vers Discord.

**Corollaire :** `docker run -e SECRET=…` rend aussi les secrets visibles dans `ps aux` pour
tout utilisateur local — préférer `--env-file` sur un fichier temporaire en 600, ou `--env VAR`
en héritant de l'environnement du process.

### 5. ✅ `usermod` avec les arguments inversés — le compte de service gagne le groupe de l'invocateur

> **Corrigé** : `sudo usermod -aG ${DOCKUP_SHELL_USER} ${currentUser}`, dans le bon ordre.
>
> Deux corrections liées dans la foulée :
>
> - **`$USER` a disparu de `config.ts`.** Il est vide sous systemd et vaut `root` sous `sudo`.
>   Un helper `getCurrentUser()` (`id -un`) le remplace dans `writeConfig`,
>   `addConfigPermission`, `removeConfigPermission` et `checkIfCurrentUserIsInDockupGroup`.
> - **Les tests d'appartenance à un groupe ne sont plus des `String.includes`** (cf. §16) :
>   `id -nG <user>` découpé sur les espaces et comparé nom entier. `docker-users` ne répond
>   plus « oui » pour `docker`, ni `dockup-admins` pour `dockup`.

**Emplacement :** `src/lib/config.ts:130-144`

```ts
export const addCurrentUserToDockupGroup = …
  await $`sudo usermod -aG $USER ${DOCKUP_SHELL_USER}`;   // usermod -aG <moi> dockup
```

Ceci ajoute l'utilisateur **`dockup` au groupe de l'utilisateur courant**, exactement l'inverse
du nom de la fonction, de son message UI (`service/init.cmd.ts:66`) et de son test
(`checkIfCurrentUserIsInDockupGroup`). Et comme `service init` doit tourner en root (voir §7),
`$USER` vaut `root` : on exécute `usermod -aG root dockup`, ce qui donne le **groupe root** à un
compte de service qui est déjà dans le groupe `docker`.

**Correctif :** `sudo usermod -aG ${DOCKUP_SHELL_USER} $(whoami)`.

### 6. ✅ Aucun échappement shell — injection depuis l'environnement des conteneurs

> **Corrigé.** `src/lib/utils.ts` expose maintenant `shellQuote()` (quotes simples, avec échappement
> de la quote elle-même) et le template tag `sh` qui quote **chaque valeur interpolée**. Tous les
> appels à `getShellOutput`/`streamShellOutput` qui interpolent quoi que ce soit sont passés par
> `sh` : IDs de conteneurs, users, bases, chemins de volumes, chemins de fichiers de secrets,
> IDs de snapshots. Un fragment pré-construit par le code lui-même (liste de `-v …`, liste de
> `-e …`) s'y insère explicitement via `raw()`, jamais une valeur externe.
>
> Vérifié : `sh\`echo ${p}\`` avec `` p = `p@ss'w"o$rd\`whoami\`;rm -rf /` `` ressort la chaîne
> à l'identique, sans substitution ni exécution.

**Emplacement :** `src/lib/utils.ts:17` et `:42`

Les deux helpers utilisent `${{ raw: cmd }}`, ce qui court-circuite entièrement la protection de
Bun Shell. Toutes les valeurs interpolées viennent de sources externes : `docker inspect` (noms
de volumes, `Source`, `Destination`), `docker exec env` (user, database, mot de passe), labels.

Un mot de passe contenant `"`, `` ` `` ou `$(…)` casse la commande au mieux, exécute du code au
pire. Le rayon de confiance est limité (vos propres conteneurs), mais la surface existe et un
simple `$` ou `!` dans un mot de passe suffit à casser un backup silencieusement.

---

## 🟡 Bugs fonctionnels confirmés

### 7. ✅ `service init` ne peut pas fonctionner tel quel

> **Corrigé**, les trois points :
>
> - Les deux fichiers d'unité sont écrits via un helper `writeSystemFile` qui pipe le contenu
>   dans `sudo tee` au lieu de `Bun.file().write()` — cohérent avec le reste du flux, et
>   `service init` n'a plus besoin d'être lancé en root.
> - `ExecStart` est absolu. `resolveExecStart()` prend `process.execPath` quand dockup tourne
>   en binaire compilé, et retombe sur `/usr/local/bin/dockup` (le chemin d'installation
>   d'`upload.sh`) quand il tourne depuis les sources, où `process.execPath` pointe sur `bun`.
> - `systemctl daemon-reload` / `enable` / `start` sont passés en `sudo`, comme dans
>   `service remove`.

- `src/lib/service.ts:16` et `:39` écrivent dans `/etc/systemd/system/` via `Bun.file().write()`
  **sans `sudo`**, alors que toutes les autres étapes du même flux utilisent `sudo`. En
  utilisateur normal → `EACCES`, et comme `service init` est volontairement abort-on-first,
  l'installation s'arrête là.
- `src/lib/service.ts:22` : `ExecStart=dockup backup`. systemd **exige un chemin absolu** et
  refuse l'unité (`Executable path is not absolute`). Il faut
  `ExecStart=/usr/local/bin/dockup backup`.
- `src/lib/service.ts:61-63` : `systemctl daemon-reload/enable/start` sans `sudo`, alors que
  `service remove` les appelle avec `sudo`.

Ces trois points ensemble font que le chemin d'installation nominal ne peut pas aboutir.

### 8. ✅ `ensureWritePermission` ne peut jamais échouer

> **Corrigé** : réécrite en `Effect.gen` avec `yield* Effect.fail(…)`, et `test -w` passé en
> `.nothrow()` (un code de sortie non nul est la réponse, pas une exception à rattraper).
> Vérifié : `/etc/dockup.conf` → `Failure(FILE_SYSTEM_PERMISSION_ERROR)`, `/tmp/x.conf` →
> `Success`.
>
> **Deuxième bug trouvé au passage :** la fonction fait déjà `dirname(p)`, mais les deux
> appelants lui passaient `dirname(configPath)`. Le test portait donc sur `dirname("/etc")`,
> soit `/` — pas `/etc`. Les appelants passent maintenant `configPath` directement, conformément
> à la signature et au message de `FileSystemPermissionError`.

**Emplacement :** `src/lib/utils.ts:142-168`

La fonction est un `Effect.promise(async () => { … return Effect.fail(…) })`. La valeur
retournée est un `Effect`, pas une erreur levée : le `Effect.fail` est **encapsulé dans le canal
de succès**. Vérifié :

```
ensureWritePermission("/etc/dockup.conf")  →  Exit { _tag: "Success", value: Effect }
```

TypeScript ne l'attrape pas parce que la variance de `A` d'Effect passe par un type fonction, et
« tout est assignable à `void` » en position de retour.

**Conséquences :** `config init` ne s'arrête plus avant de poser les 5 questions
(`init.cmd.ts:22`), et `config check` affiche **toujours** « config write permission : granted »
(`check.cmd.ts:35`).

**Correctif :** un `Effect.gen` avec `yield* Effect.fail(…)`.

### 9. ✅ `$localhost` dans les URI Postgres

> **Corrigé** en supprimant l'URI. `pg_dump` et `psql` reçoivent `-U <user> -d <database>` (les
> deux quotés par `sh`) et le mot de passe par `PGPASSWORD`. Le comportement effectif est
> inchangé — connexion par socket Unix locale dans le conteneur, exactement ce que faisait
> l'URI amputée — mais il est maintenant celui qui est écrit, et un `@`, `/`, `#` ou `?` dans
> le mot de passe, l'utilisateur ou le nom de base ne casse plus rien.

**Emplacement :** `src/lib/backup.ts:166` et `:192`

`@$localhost:5432` — le `$` parasite fait que le shell substitue une variable vide. Vérifié :
`postgresql://u:p@$localhost:5432/db` → `postgresql://u:p@:5432/db`. Ça marche par accident
(libpq retombe sur la socket Unix locale dans le conteneur), mais ce n'est pas ce qui est écrit
et le comportement diffère de l'intention.

Au passage, `pg.password` n'est **pas percent-encodé** dans l'URI : un `@`, `/`, `#` ou `?` dans
le mot de passe casse le parsing.

### 10. ✅ `host.docker.internal` avec `--network host` ne résout pas sous Linux

> **Corrigé** : la substitution a disparu avec la réécriture de `formatResticConfigToEnvArgs`
> (cf. §4). `RESTIC_REPOSITORY` est transmis tel quel ; le conteneur restic tournant en
> `--network host`, `localhost` désigne déjà l'hôte sous Linux.
>
> ⚠️ Conséquence pour le dev sous Docker Desktop (macOS/Windows) : `--network host` n'y
> fonctionne pas de toute façon, ce chemin n'était donc pas exerçable localement avant non plus.

**Emplacement :** `src/lib/docker.ts:199`

Le code remplace `localhost` par `host.docker.internal` — un artefact de Docker Desktop, qui
n'existe pas sous Linux sans `--add-host`. Or la cible de production est Linux, et le conteneur
tourne déjà en `--network host` (donc `localhost` aurait fonctionné directement). Hack de dev
qui a fuité en prod ; à retirer ou à conditionner.

### 11. Message Discord vide

**Emplacement :** `src/lib/discord.ts:35`

`output.push(message)` inconditionnel. Vérifié : `formatDiscordReport([])` → `[""]`, ce qui
produit un POST avec `content: ""` que Discord rejette en 400 (avalé silencieusement par
`catchAll`). Idem si une seule ligne dépasse 2 000 caractères : elle est envoyée telle quelle et
rejetée.

**Correctif :** filtrer les chunks vides et découper les lignes trop longues.

### 12. ✅ `.env()` remplace tout l'environnement — plus de `PATH`, plus de `HOME`

> **Corrigé** : `streamShellOutput` et les trois appels de `restic.ts` passent maintenant
> `{ ...process.env, ...env }`. Vérifié : `HOME` est de nouveau visible dans les sous-processus.

**Emplacement :** `src/lib/utils.ts:42` (`.env(args.env ?? {})`), `src/lib/restic.ts:47`, `:147`, `:271`

Vérifié : `$\`env\`.env({FOO:"bar"})`n'affiche que`FOO=bar`, et `printenv PATH`dans un`streamShellOutput` sans env retourne vide.

Bun résout le binaire lui-même donc les commandes se lancent, mais les sous-processus tournent :

- sans `HOME` → restic ne trouve plus son cache `~/.cache/restic`, d'où dégradation de perf et
  warnings ;
- sans `DOCKER_HOST`/`DOCKER_CONFIG` → casse tout setup Docker non standard ;
- sans proxy/TZ/locale.

**Correctif :** `.env({ ...process.env, ...env })`.

### 13. `ensureRepoInitialized` confond « lent » et « non initialisé »

**Emplacement :** `src/lib/restic.ts:288-304`

`timeout: 5000` sur `restic snapshots` ; un dépôt S3 volumineux ou un réseau lent dépasse 5 s,
le process est tué, `exitCode !== 0`, et on affiche « le dépôt ne semble pas initialisé — lancez
`dockup restic init` ». Conseil dangereux sur un dépôt qui existe.

**Correctif :** distinguer le timeout du code de sortie et remonter `stderr`.

### 14. ✅ `jounalctl`

> **Corrigé** : `journalctl`. La fonction reste inutilisée (cf. §16).

**Emplacement :** `src/lib/service.ts:74`

Faute de frappe (`journalctl`). Sans impact aujourd'hui : la fonction est morte, ce qui explique
que personne ne l'ait vue.

### 15. `backup` ne vérifie ni les droits Docker ni l'état du dépôt

**Emplacement :** `src/commands/backup.cmd.ts`

La commande n'appelle ni `ensureDockerPermissions()` ni `ensureRepoInitialized()`, contrairement
à `restore` et `config check`. Si le service systemd tourne sans le groupe `docker`, chaque
conteneur échoue individuellement et Discord reçoit N alertes au lieu d'un diagnostic clair.

---

## 🔵 Qualité de code

### Code mort (~140 lignes)

Toute la famille `matchError` / `matchErrorEffect` / `matchErrorPartial` /
`MatchTypeErrorBuilder` (`src/lib/effect.ts:61-165`, très chargée en `any`) n'est utilisée
**nulle part** — alors que `CLAUDE.md` la présente comme le mécanisme de gestion d'erreur du
projet : la doc décrit donc un outil inexistant.

Idem pour :

- `LogTag` (`effect.ts:10-11`)
- `readServiceLogs` et `checkServiceStatus` (`service.ts:72-74`)
- `ContainerBackupInfosParsingError` (déclaré dans la signature de
  `listBackupEnabledContainers` mais jamais construit)
- `ResticSuccessfulVolumeBackupStructuredOutput` (`restic.ts:102`)
- le champ `fileWriter` de `StreamShellOutputArgs` (`utils.ts:30`)

### Tags Effect structurellement identiques

`Context.GenericTag<Config>("ConfigTag")` et `Context.GenericTag<Config>("LogTag")`
(`effect.ts:10,13`) partagent le même type d'identifiant. Le canal `R` de tous vos effets est
littéralement `Config`, pas un tag opaque : deux services distincts deviennent interchangeables
au niveau des types.

**Correctif :** passer par `Context.Tag<"ConfigTag", Config>()` (ou une interface identifiante
dédiée).

### Validations et wrappers sans effet

- `docker.ts:30-40` : `z.string().array().safeParse(result)` sur une valeur déjà typée
  `string[]` issue d'un `.split()` — ne peut pas échouer.
- `restic.ts:172-179` : `Effect.try` autour de `o.trim().split("\n").at(-1)` — aucune de ces
  opérations ne lève.
- `prompts.ts:59-62` : `Effect.map(result => { …; return Effect.void })` — retourne un `Effect`
  comme valeur au lieu d'un `flatMap`/`tap`. Inoffensif, mais trompeur.

### Capture par effet de bord

`check.cmd.ts:41-58` : `config` est affecté depuis le callback `onSuccess` d'un `safeSpinner`,
puis relu — d'où le `config as Config` qui trahit que TypeScript n'y croit pas. `safeSpinner`
devrait rendre `Effect<Option<A>>` (ou `A | null`) plutôt que de forcer une variable mutable.

### Divers

- `writeConfig` (`config.ts:76-91`) est typé `Effect<void, never>` mais fait 3 opérations shell
  qui peuvent échouer → tout échec devient un _defect_ rendu « This is a bug in dockup ». C'est
  justement ce que le reste du code évite soigneusement.
- Nom de conteneur figé `--name dockup-restic-backup` utilisé aussi pour les **restores**
  (`backup.ts:224`, `:279`) — nom trompeur, et collision si un résidu d'un run interrompu
  subsiste.
- `checkIfUserIsInDockerGroup` / `checkIfCurrentUserIsInDockupGroup` (`config.ts:110-118`)
  testent par `String.includes` : un groupe `docker-users` ou `dockup-admins` donne un faux
  positif.
- `docker.ts:216-231` : le parsing de `docker exec … env` par `split("\n")` casse sur toute
  variable multi-ligne (certificats, clés PEM) — les lignes suivantes deviennent des clés bidon.
- `docker ps --filter` (`docker.ts:27`) ne liste que les conteneurs **démarrés** : un service
  labellisé mais arrêté est ignoré sans le moindre avertissement dans le rapport.
- `backupVolumes` sauvegarde **tous** les mounts sans filtre, y compris les bind-mounts en
  lecture seule, les sockets et `/run/secrets/*` — des secrets en clair peuvent finir dans le
  dépôt restic.
- `mariadb-dump … -C` (`backup.ts:80`) : `-C` est `--compress` (protocole client/serveur,
  déprécié), sans effet utile sur un `docker exec` local — probablement `--complete-insert`
  était visé.
- `bun run check` échoue actuellement (formatage de `.oxlintrc.json` et `.vscode/settings.json`)
  : `bun run fix` règle ça.
- Il n'y a aucun test, et les trois bugs critiques ci-dessus (§1, §2, §3) sont précisément ceux
  qu'un test d'intégration sur la stack `docker/` aurait attrapés immédiatement.

---

## Ordre de traitement suggéré

1. **§1 pipefail** et **§2 `MARIADB_PASSWORD`** — ce sont des pertes de données silencieuses.
2. **§4 fuite de secrets** vers Discord.
3. **§7 `service init`** (le chemin d'installation ne fonctionne pas) et **§5 `usermod`**.
4. **§8 `ensureWritePermission`** et **§3 fail-fast** de la découverte.
5. Le reste au fil de l'eau ; le nettoyage du code mort de `effect.ts` fera gagner 140 lignes et
   alignera `CLAUDE.md` sur la réalité.
