CREATE TABLE IF NOT EXISTS customers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    full_name VARCHAR(100) NOT NULL,
    account_type VARCHAR(20) DEFAULT 'standard',
    last_update TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Procédure pour insérer 100 lignes
DELIMITER //
CREATE PROCEDURE SeedMariaDB()
BEGIN
    DECLARE i INT DEFAULT 1;
    WHILE i <= 100 DO
        INSERT INTO customers (full_name, account_type) 
        VALUES (CONCAT('Customer ', i), IF(i % 10 = 0, 'premium', 'standard'));
        SET i = i + 1;
    END WHILE;
END //
DELIMITER ;

CALL SeedMariaDB();
DROP PROCEDURE SeedMariaDB;