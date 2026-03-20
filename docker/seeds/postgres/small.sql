CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) NOT NULL,
    email VARCHAR(100) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Génération de 100 lignes d'exemple
INSERT INTO users (username, email)
SELECT 
    'user_' || i,
    'user_' || i || '@example.com'
FROM generate_series(1, 100) AS i;

CREATE TABLE logs (
    id SERIAL PRIMARY KEY,
    user_id INT REFERENCES users(id),
    action TEXT,
    occurred_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO logs (user_id, action)
SELECT 
    floor(random() * 100 + 1)::int,
    'Login attempt ' || i
FROM generate_series(1, 100) AS i;

-- -- 1. Création de la table
-- CREATE TABLE IF NOT EXISTS big_data (
--     id SERIAL PRIMARY KEY,
--     created_at TIMESTAMP DEFAULT now(),
--     payload TEXT,
--     metadata JSONB
-- );

-- -- 2. Désactivation temporaire des logs pour aller plus vite (Optionnel)
-- -- ALTER TABLE big_data SET UNLOGGED; 

-- -- 3. Insertion massive (environ 10 Go)
-- -- On génère 10 séries de 1 000 000 de lignes
-- -- Chaque ligne contient une chaîne de 1000 caractères aléatoires
-- INSERT INTO big_data (payload, metadata)
-- SELECT 
--     repeat(md5(random()::text), 30), -- Environ 960 caractères
--     jsonb_build_object('ref', random(), 'active', true)
-- FROM generate_series(1, 10000000);

-- -- 4. On remet en mode LOGGED si on l'avait désactivé
-- -- ALTER TABLE big_data SET LOGGED;

-- -- 5. On force le calcul des stats pour Postgres
-- VACUUM ANALYZE big_data;