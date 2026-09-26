CREATE TABLE sip_accounts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
 client_id uuid NOT NULL UNIQUE REFERENCES painel_clients(id) ON DELETE CASCADE,
 username text NOT NULL UNIQUE CHECK (username ~ '^sx_[a-f0-9]{24}$'),
 digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{32}$'),
 enabled boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sip_accounts_company_id_idx ON sip_accounts(company_id);
CREATE VIEW synexa_sip_endpoints AS
 SELECT s.username AS id, 'transport-udp'::text AS transport,
 'synexa-client'::text AS context, s.username AS auth, s.username AS aors,
 'all'::text AS disallow, 'ulaw,alaw'::text AS allow,
 'no'::text AS direct_media, 'yes'::text AS rtp_symmetric,
 'yes'::text AS force_rport, 'yes'::text AS rewrite_contact,
 'no'::text AS allow_transfer, 'no'::text AS allow_subscribe
 FROM sip_accounts s JOIN companies c ON c.id=s.company_id
 JOIN painel_clients p ON p.id=s.client_id AND p.company_id=s.company_id
 WHERE s.enabled AND c.status='active';
CREATE VIEW synexa_sip_auths AS
 SELECT s.username AS id, 'md5'::text AS auth_type, s.username,
 'asterisk'::text AS realm, s.digest AS md5_cred
 FROM sip_accounts s JOIN synexa_sip_endpoints e ON e.id=s.username;
CREATE VIEW synexa_sip_aors AS
 SELECT id, 1 AS max_contacts, 'yes'::text AS remove_existing,
 0 AS qualify_frequency FROM synexa_sip_endpoints;
CREATE VIEW synexa_sip_routes AS
 SELECT DISTINCT s.username, t.did_number, s.client_id
 FROM sip_accounts s JOIN synexa_sip_endpoints e ON e.id=s.username
 JOIN telephony_endpoints t ON t.client_id=s.client_id AND t.company_id=s.company_id
 WHERE t.enabled;
REVOKE ALL ON synexa_sip_endpoints, synexa_sip_auths, synexa_sip_aors, synexa_sip_routes FROM PUBLIC;
