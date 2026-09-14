#!/usr/bin/env bash
#
# Redéfinit le mot de passe des rôles qu'une restauration dockup vient de créer.
#
# Le prélude d'un dump postgres recrée les propriétaires manquants sur la
# destination, jamais leur mot de passe : un rôle LOGIN en ressort donc sans
# moyen de s'authentifier. Ceux-là, et eux seuls, ont `rolpassword IS NULL` —
# c'est le marqueur sur lequel ce script s'appuie.
#
#   ./dockup-restore-passwords.sh <container>                    # liste, ne touche à rien
#   ./dockup-restore-passwords.sh <container> portfolio=s3cr3t   # applique
#   ./dockup-restore-passwords.sh <container> --generate         # génère et affiche
#
# Aucun mot de passe ne transite par une ligne de commande : le SQL est
# assemblé ici et poussé sur stdin de psql.

set -euo pipefail

CONTAINER="${1:?usage: $0 <container> [<role>=<password> ...] [--generate]}"
shift

PG_USER="$(docker exec "$CONTAINER" printenv POSTGRES_USER)"
PG_PASSWORD_FILE="$(docker exec "$CONTAINER" printenv POSTGRES_PASSWORD_FILE 2>/dev/null || true)"
if [ -n "$PG_PASSWORD_FILE" ]; then
  PGPASSWORD="$(docker exec "$CONTAINER" cat "$PG_PASSWORD_FILE")"
else
  PGPASSWORD="$(docker exec "$CONTAINER" printenv POSTGRES_PASSWORD)"
fi
export PGPASSWORD

# psql sur la base d'administration, le SQL venant toujours de stdin : ni mot de
# passe ni identifiant ne se retrouve dans la table des processus.
psql_exec() { docker exec -i -e PGPASSWORD "$CONTAINER" psql -v ON_ERROR_STOP=1 -w -q -U "$PG_USER" -d postgres -f - ; }
psql_query() { docker exec -i -e PGPASSWORD "$CONTAINER" psql -v ON_ERROR_STOP=1 -w -tA -U "$PG_USER" -d postgres -f - ; }

# Le motif et le remplacement sont eux-mêmes cités, sinon bash réinjecte les
# backslashes de l'échappement dans la sortie et psql lit `\'` comme une
# méta-commande au lieu d'une apostrophe doublée.
# `tr </dev/urandom | head -c 32` renvoie 141 : head ferme le tube, tr prend un
# SIGPIPE et pipefail le remonte. On borne l'entrée et on tronque dans bash.
gen_password() {
  local raw=""
  while [ ${#raw} -lt 32 ]; do
    raw="$raw$(head -c 256 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9')"
  done
  printf '%s' "${raw:0:32}"
}

sql_literal() { local escaped=${1//"'"/"''"}; printf "'%s'" "$escaped"; }
sql_ident() { local escaped=${1//'"'/'""'}; printf '"%s"' "$escaped"; }

# Un rôle LOGIN sans mot de passe est soit sorti du prélude de restauration,
# soit déjà inutilisable avant : dans les deux cas il en faut un.
ORPHANS="$(psql_query <<'SQL'
select rolname from pg_authid
where rolcanlogin and rolpassword is null and left(rolname, 3) <> 'pg_'
order by rolname
SQL
)"

if [ -z "$ORPHANS" ]; then
  echo "Aucun rôle LOGIN sans mot de passe : rien à faire."
  exit 0
fi

GENERATE=false
declare -a ASSIGNMENTS=()
for arg in "$@"; do
  case "$arg" in
    --generate) GENERATE=true ;;
    *=*) ASSIGNMENTS+=("$arg") ;;
    *) echo "argument non reconnu : $arg" >&2; exit 2 ;;
  esac
done

if [ ${#ASSIGNMENTS[@]} -eq 0 ] && [ "$GENERATE" = false ]; then
  echo "Rôles LOGIN sans mot de passe (créés par la restauration) :"
  printf '  %s\n' $ORPHANS
  echo
  echo "Relancer avec <role>=<password> pour chacun, ou --generate."
  exit 0
fi

statements=""
applied=""
for role in $ORPHANS; do
  password=""
  # `${x[@]+"${x[@]}"}` : sous `set -u`, bash 3.2 traite un tableau vide comme
  # une variable non définie et avorte sur l'expansion nue.
  for assignment in ${ASSIGNMENTS[@]+"${ASSIGNMENTS[@]}"}; do
    [ "${assignment%%=*}" = "$role" ] && password="${assignment#*=}"
  done
  if [ -z "$password" ]; then
    if [ "$GENERATE" = true ]; then
      password="$(gen_password)"
      applied+="  $role  $password"$'\n'
    else
      echo "  $role : aucun mot de passe fourni, ignoré." >&2
      continue
    fi
  else
    applied+="  $role  (fourni)"$'\n'
  fi
  statements+="alter role $(sql_ident "$role") password $(sql_literal "$password");"$'\n'
done

[ -z "$statements" ] && { echo "Rien à appliquer."; exit 0; }

printf '%s' "$statements" | psql_exec
echo "Mots de passe redéfinis :"
printf '%s' "$applied"
