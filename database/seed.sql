INSERT INTO users (id, role, name, organization_name, email, password_hash, verified, created_at) VALUES
('admin', 'organization', 'ExpoESCOM', 'ExpoESCOM', 'admin@expo.test', '$2a$10$7u4WxOEzpjHXVFRhk/KFWu4MRkWRBqSe.xLgSno89zWo8KjEWaUKm', true, NOW()),
('org-lumina', 'organization', 'Lumina Eventos', 'Lumina Eventos', 'lumina@expo.test', '$2a$10$7u4WxOEzpjHXVFRhk/KFWu4MRkWRBqSe.xLgSno89zWo8KjEWaUKm', true, NOW()),
('org-zenit', 'organization', 'Zenit Producciones', 'Zenit Producciones', 'zenit@expo.test', '$2a$10$7u4WxOEzpjHXVFRhk/KFWu4MRkWRBqSe.xLgSno89zWo8KjEWaUKm', true, NOW()),
('WwqvD_IDtYVL', 'user', 'Aaron Avila', NULL, 'aaron.axel1997@gmail.com', '$2a$10$EnwVtS0FLPrEPGyh8sWODuextJG1eWrMKgcd3gLuvT6QgiPx1oCnq', true, NOW())
ON CONFLICT (id) DO NOTHING;

INSERT INTO events (id, organization_id, name, date, time, venue, organizer, price, currency, price_mxn, status, created_at) VALUES
('evt-crypto', 'admin', 'Expo Cripto: Acceso Seguro', '2026-06-04', '11:00', 'ESCOM IPN - Auditorio Principal', 'ExpoESCOM', 80, 'MXN', 80, 'active', NOW()),
('evt-taller-aes', 'admin', 'Taller AES para Boletos Privados', '2026-07-03', '12:00', 'ESCOM IPN - Laboratorio 4', 'ExpoESCOM', 65, 'MXN', 65, 'active', NOW()),
('evt-expo-firmas', 'admin', 'Laboratorio de Firmas ECDSA', '2026-08-14', '13:00', 'ESCOM IPN - Aula Magna', 'ExpoESCOM', 95, 'MXN', 95, 'active', NOW()),
('evt-lumina-synth', 'org-lumina', 'Lumina Live: Noche de Synth Pop', '2026-06-12', '20:30', 'Pepsi Center', 'Lumina Eventos', 1250, 'MXN', 1250, 'active', NOW()),
('evt-lumina-arena', 'org-lumina', 'Festival Lumina Arena', '2026-07-18', '19:00', 'Arena Ciudad de Mexico', 'Lumina Eventos', 5200, 'MXN', 5200, 'active', NOW()),
('evt-lumina-acustico', 'org-lumina', 'Lumina Acustico VIP', '2026-08-21', '21:00', 'Teatro Metropolitano', 'Lumina Eventos', 14800, 'MXN', 14800, 'active', NOW()),
('evt-zenit-cinema', 'org-zenit', 'Zenit Cinema: Ciclo de Autor', '2026-06-20', '18:00', 'Cineteca Nacional', 'Zenit Producciones', 450, 'MXN', 450, 'active', NOW()),
('evt-zenit-arte', 'org-zenit', 'Zenit Arte: Exposicion Inmersiva', '2026-08-02', '17:30', 'Museo Digital', 'Zenit Producciones', 980, 'MXN', 980, 'active', NOW()),
('evt-zenit-corto', 'org-zenit', 'Festival Zenit de Cortometraje', '2026-09-04', '18:00', 'Foro de Arte Contemporaneo', 'Zenit Producciones', 1750, 'MXN', 1750, 'active', NOW())
ON CONFLICT (id) DO NOTHING;

INSERT INTO app_meta (key, value) VALUES ('state', '{"seedVersion":5}'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
