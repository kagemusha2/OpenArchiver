# MBOX Auto-Import API

This API allows you to trigger automatic ingestion of MBOX files from a configured storage folder.

## Overview

The MBOX auto-import feature scans a designated folder in your storage backend (local filesystem or S3) for `.mbox` files, parses them, and imports all emails and attachments into the Open Archiver system.

## Configuration

The following environment variables control the MBOX auto-import behavior:

| Variable | Default | Description |
|----------|---------|-------------|
| `S3_UPLOADS_PREFIX` | `Uploads/` | The folder prefix where MBOX files should be placed for import |
| `S3_MBOX_POST_PROCESS_ACTION` | `move` | Action after processing: `move` (to processed folder), `delete`, or `keep` |

## Endpoints

### Trigger MBOX Import

**POST** `/api/v1/import/mbox`

Triggers the import of all `.mbox` files found in the configured uploads folder.

#### Request

No request body required.

#### Response

```json
{
  "message": "MBOX import completed successfully",
  "filesFound": 2,
  "filesProcessed": 2,
  "filesFailed": 0,
  "totalEmailsProcessed": 150,
  "totalEmailsFailed": 0,
  "results": [
    {
      "filePath": "Uploads/archive1.mbox",
      "status": "success",
      "emailsProcessed": 100,
      "emailsFailed": 0
    },
    {
      "filePath": "Uploads/archive2.mbox",
      "status": "success",
      "emailsProcessed": 50,
      "emailsFailed": 0
    }
  ]
}
```

#### Status Codes

| Code | Description |
|------|-------------|
| 200 | Import completed successfully (all files processed) |
| 207 | Multi-Status - Import completed with some failures |
| 500 | Import failed for all files or server error |

#### Permissions

- Requires authentication (JWT token or API key)
- Requires `create` permission on `ingestion` resource

### Get Import Configuration

**GET** `/api/v1/import/mbox/config`

Returns the current MBOX import configuration.

#### Response

```json
{
  "uploadsPrefix": "Uploads/",
  "postProcessAction": "move",
  "processedPrefix": "Uploads/processed/"
}
```

#### Permissions

- Requires authentication (JWT token or API key)
- Requires `read` permission on `ingestion` resource

## Usage Example

### Using cURL

```bash
# Trigger MBOX import
curl -X POST \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  http://localhost:4000/api/v1/import/mbox

# Or using API key
curl -X POST \
  -H "X-API-Key: YOUR_API_KEY" \
  http://localhost:4000/api/v1/import/mbox

# Get current configuration
curl -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  http://localhost:4000/api/v1/import/mbox/config
```

### Workflow

1. Upload MBOX files to the configured uploads folder (e.g., `Uploads/` in your S3 bucket or local storage)
2. Call `POST /api/v1/import/mbox` to trigger the import
3. The system will:
   - Scan for all `.mbox` files in the uploads folder
   - Create an ingestion source for each file
   - Parse and import all emails and attachments
   - Move, delete, or keep the processed files based on configuration
4. Check the response for import results and any errors

## Post-Processing Actions

After successfully processing an MBOX file, the system can perform one of the following actions:

| Action | Description |
|--------|-------------|
| `move` | Moves the file to `Uploads/processed/` folder (default) |
| `delete` | Permanently deletes the processed file |
| `keep` | Leaves the file in its original location |

::: warning
When using `keep`, subsequent import triggers will attempt to re-process the same files. Consider using `move` or `delete` to avoid duplicate processing.
:::

## Error Handling

If processing fails for individual emails within an MBOX file, the import continues with remaining emails. The response includes:
- `emailsFailed` count per file
- `status: "partial"` when some emails failed but others succeeded
- Detailed error information in server logs

If an entire file fails to process, it will be reported with `status: "error"` and an error message.
