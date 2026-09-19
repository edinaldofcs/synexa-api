INSERT INTO provider_credentials (id, company_id, client_id, provider, api_key_enc, label, status, enabled_models, created_at, updated_at)
SELECT gen_random_uuid(), '3a13d7e7-c1dd-4a7b-9971-75752477fbf9', '388a03d7-dd45-4918-9cc3-a9e7f302bd04', provider, api_key_enc, label, status, enabled_models, NOW(), NOW()
FROM provider_credentials
WHERE client_id = '1c2170a4-aff5-41c0-a74c-47411df65f53'
ON CONFLICT (client_id, provider, label) DO UPDATE
SET api_key_enc = EXCLUDED.api_key_enc, status = EXCLUDED.status, updated_at = NOW();
