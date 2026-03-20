-- 1. Création de la table
CREATE TABLE IF NOT EXISTS big_data (
    id SERIAL PRIMARY KEY,
    created_at TIMESTAMP DEFAULT now(),
    payload TEXT,
    metadata JSONB
);

-- 2. Désactivation temporaire des logs pour aller plus vite (Optionnel)
ALTER TABLE big_data SET UNLOGGED; 

-- 3. Insertion massive (environ 10 Go)
-- On génère 10 séries de 1 000 000 de lignes
-- Chaque ligne contient une chaîne de 1000 caractères aléatoires
INSERT INTO big_data (payload, metadata)
SELECT 
    repeat(md5(random()::text), 30), -- Environ 960 caractères
    jsonb_build_object('ref', random(), 'active', true)
FROM generate_series(1, 10000000);

-- 4. On remet en mode LOGGED si on l'avait désactivé
ALTER TABLE big_data SET LOGGED;

-- 5. On force le calcul des stats pour Postgres
VACUUM ANALYZE big_data;