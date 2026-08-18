# Prune orphan video previews

This is a dry-run-first maintenance tool for preview objects left behind when a
`vid_preview` row is updated to reference a new object ID.

The tool does not modify Museum or PostgreSQL. It treats the database as the
source of truth and preserves:

- the segment and playlist referenced by every live `file_data` row;
- objects still present in `temp_objects`;
- objects newer than the configured grace period; and
- keys that do not exactly match Ente's video-preview key format.

It refuses to operate on a bucket with versioning enabled or suspended.

## Dry run

Use standard AWS environment variables or a shared AWS profile. Keep the
database URL outside shell history when possible.

```powershell
$env:ENTE_DATABASE_URL = "postgres://museum:password@db/museum?sslmode=require"
$env:AWS_PROFILE = "ente-derived-storage"

Set-Location server
go run ./tools/prune-orphan-video-previews `
  --bucket ente-derived `
  --endpoint-url https://s3.example.com `
  --grace-period 48h `
  --report video-preview-orphans.json
```

Review the JSON report. It contains every exact object key, size, ETag, and last
modified time proposed for deletion. No object is deleted during this command.

## Apply an unchanged report

The dry run prints the SHA-256 of the report. Application requires the exact
report and hash, re-reads the database protection sets, and performs a HEAD
check before each delete.

```powershell
go run ./tools/prune-orphan-video-previews `
  --bucket ente-derived `
  --endpoint-url https://s3.example.com `
  --apply-report video-preview-orphans.json `
  --confirm-sha256 <hash-from-dry-run> `
  --max-deletes 500
```

Run separate dry-run and apply passes for every primary or replica bucket. Start
with a narrow `--prefix <userID>/file-data/` when validating a production
deployment.

## Draft limitations

- The tool stops on the first changed or failed object; rerun the dry run before
  retrying.
- It processes deletions sequentially.
- Versioned buckets require a separate implementation that records and deletes
  explicit version IDs and delete markers.
- This draft should be tested against a read-only database account and a staging
  bucket before production use.
