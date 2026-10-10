-- Keep one current verification document per provider and document type.
-- PHOTO_WORK remains a multi-file gallery and is intentionally excluded.
DELETE FROM provider_documents
WHERE doc_type <> 'PHOTO_WORK'
  AND id NOT IN (
    SELECT id FROM (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY provider_id, doc_type ORDER BY created_at DESC, id DESC) AS rn
      FROM provider_documents
      WHERE doc_type <> 'PHOTO_WORK'
    ) WHERE rn = 1
  );
CREATE UNIQUE INDEX IF NOT EXISTS ux_provider_documents_current_type
  ON provider_documents(provider_id, doc_type)
  WHERE doc_type <> 'PHOTO_WORK';
