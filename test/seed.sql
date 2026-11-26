-- Runs unchanged on both MySQL and PostgreSQL.
CREATE TABLE customer (id INT PRIMARY KEY, name VARCHAR(255) NOT NULL, note TEXT);
CREATE TABLE orders (id INT PRIMARY KEY, customer_id INT NOT NULL, total DECIMAL(10,2), created_at TIMESTAMP);
CREATE TABLE nopk (a INT);
CREATE VIEW big_orders AS SELECT * FROM orders WHERE total > 100;
INSERT INTO customer VALUES (1, 'Ada', NULL), (2, 'Grace', 'vip'), (3, 'Linus', NULL);
INSERT INTO orders VALUES (1, 1, 50.00, '2025-01-01 10:00:00'), (2, 2, 250.50, '2025-01-02 11:00:00');
INSERT INTO nopk VALUES (1);
