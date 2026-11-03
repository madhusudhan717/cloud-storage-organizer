# Cloud Storage Organizer — Object Storage & Access Controls

A security-first Python and S3/MinIO object storage management utility designed to upload, categorize, tag, inspect, download, and manage files with strict **private-by-default access controls**, **isolated public-read sandbox testing**, and **time-limited HMAC-SHA256 pre-signed URLs**.

---

## 1. Project Overview and Objectives

Modern cloud applications rely on S3-compatible object storage for unstructured data (PDFs, images, CSV datasets, engineering reports). Misconfigured buckets and overly permissive ACLs remain a leading cause of cloud data breaches.

**Cloud Storage Organizer** demonstrates how to engineer secure object storage workflows locally at zero cloud cost using **MinIO** (or **AWS S3** in production):

- **Private-by-Default Architecture**: All objects uploaded to the primary bucket (`cloud-organizer-private`) deny anonymous read/list requests (`HTTP 403 AccessDenied`).
- **Prefix-Based Categorization**: Enforces structured folder-like prefixes (`documents/`, `images/`, `reports/`, `projects/`).
- **Rich Metadata & Object Tagging**: Attaches custom `x-amz-meta-*` attributes (`department`, `owner`, `description`) and mutable S3 object tags (`Category=Academic`, `Type=Report`).
- **Cryptographic Pre-Signed URLs**: Generates temporary bearer links with configurable TTLs (`60 seconds`, `5 minutes`, `15 minutes`) without altering bucket policies or exposing credentials.
- **Isolated Public-Read Sandbox**: Demonstrates public-read bucket policies strictly inside a separate disposable bucket (`cloud-organizer-public-sandbox`) after explicit operator confirmation.

---

## 2. Architecture and Workflow

```text
+-------------------------------------------------------------------------+
|                   Streamlit UI (app.py) / Web Console                   |
|  - Upload & Prefix Selector        - Metadata & Tag Editor              |
|  - Category & Search Explorer      - Pre-Signed URL Generator (TTL)     |
+------------------------------------+------------------------------------+
                                     |
                                     v
+-------------------------------------------------------------------------+
|                     StorageManager (storage_manager.py)                 |
|  - Filename Sanitization (Path Traversal Protection)                    |
|  - Secret Masking (config.py)      - SigV4 / Boto3 S3 Client            |
+------------------+-----------------------------------+------------------+
                   |                                   |
                   v (Default: Private)                v (Explicit Confirmation Only)
+------------------------------------+   +--------------------------------+
|  Main Bucket:                      |   |  Isolated Sandbox Bucket:      |
|  cloud-organizer-private           |   |  cloud-organizer-public-sandbox|
|  - Anonymous Access: 403 Forbidden |   |  - Disposable Demo Objects     |
|  - Authorized API + Pre-Signed URL |   |  - Never touches Private Vault |
+------------------------------------+   +--------------------------------+
```

### Project Directory Structure

```text
cloud-storage-organizer/
├── app.py
├── storage_manager.py
├── config.py
├── requirements.txt
├── .env.example
├── .gitignore
├── docker-compose.yml
├── README.md
├── storage/
│   └── .gitkeep
└── tests/
    ├── test_storage_manager.py
    └── test_security.py
```

---

## 3. Prerequisites and Installation

- **Python**: Python 3.10 – 3.12+
- **Docker & Docker Compose**: Required for running the local MinIO server container
- **Git**: For version control

### Clone and Set Up Virtual Environment

**Windows PowerShell:**
```powershell
cd cloud-storage-organizer
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

**Linux / macOS:**
```bash
cd cloud-storage-organizer
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

---

## 4. Docker and MinIO Setup

The included `docker-compose.yml` launches **MinIO** on port `9000` (S3 API) and `9001` (MinIO Web Console) and runs an automated `minio-init` container (`mc`) that creates both buckets with anonymous access disabled (`mc anonymous set none`).

**Windows PowerShell & Linux / macOS:**
```bash
docker compose up -d
docker compose ps
```

- **S3 API Endpoint**: `http://localhost:9000`
- **MinIO Web Console**: `http://localhost:9001`

### Manual Bucket Verification with MinIO Client (Optional)
If you wish to inspect buckets manually inside the container:
```bash
docker exec -it cloud-storage-organizer-minio mc ls localminio/
```

---

## 5. Environment Configuration

Copy `.env.example` to `.env` and customize your local development credentials. **Never commit `.env` to Git.**

**Windows PowerShell:**
```powershell
Copy-Item .env.example .env
```

**Linux / macOS:**
```bash
cp .env.example .env
```

### `.env` Variables Reference

| Variable | Example Value | Description |
| :--- | :--- | :--- |
| `S3_ENDPOINT_URL` | `http://localhost:9000` | MinIO or AWS S3 endpoint URL |
| `S3_ACCESS_KEY` | `minioadmin` | S3 / MinIO access key ID |
| `S3_SECRET_KEY` | `CHANGE_ME_LOCAL_MINIO_SECRET` | Secret signing key (masked in UI & logs) |
| `S3_BUCKET_NAME` | `cloud-organizer-private` | Primary private bucket |
| `S3_PUBLIC_DEMO_BUCKET` | `cloud-organizer-public-sandbox` | Isolated disposable bucket for public-read demo |
| `S3_REGION` | `us-east-1` | AWS/MinIO region identifier |
| `DEFAULT_PRESIGNED_EXPIRATION` | `300` | Default pre-signed URL TTL in seconds (5 minutes) |

---

## 6. How to Start the Application

**Windows PowerShell & Linux / macOS:**
```bash
streamlit run app.py
```

Open `http://localhost:8501` in your browser to access the Streamlit dashboard.

---

## 7. Examples: Uploading, Listing, Downloading, Tagging, and Deleting Files

You can perform all operations either through the Streamlit UI or programmatically via `StorageManager`:

```python
from config import StorageConfig
from storage_manager import StorageManager

manager = StorageManager(StorageConfig.from_env())
manager.ensure_buckets_exist()

# 1. Upload a file under the 'reports/' prefix with custom metadata and tags
obj = manager.upload_file(
    file_content=b"quarter,revenue\nQ1,125000\nQ2,148000\n",
    filename="financial_summary.csv",
    category="reports",
    metadata={"department": "Finance", "owner": "cfo-office", "description": "H1 revenue"},
    tags={"Category": "Academic", "Type": "Report"},
)
print("Uploaded:", obj.key, obj.access_mode)  # reports/financial_summary.csv Private

# 2. List objects filtered by category prefix
reports = manager.list_objects(category_filter="reports")
for item in reports:
    print(item.key, item.size_bytes, item.tags)

# 3. Retrieve and update object tags
meta, tags, content_type = manager.get_object_metadata_and_tags("reports/financial_summary.csv")
manager.update_object_tags("reports/financial_summary.csv", {"Category": "Executive", "Type": "Verified"})

# 4. Download file into the sandboxed storage/ directory
saved_path = manager.download_to_safe_storage("reports/financial_summary.csv")
print("Saved safely to:", saved_path)

# 5. Delete file with explicit confirmation
manager.delete_object("reports/financial_summary.csv", confirmed=True)
```

---

## 8. How Private and Public-Read Access Differ

Understanding the three layers of S3 access control is essential for cloud security:

1. **IAM Permissions (Identity-Based)**:
   Attached to IAM users, groups, or roles. Determines what API calls an authenticated principal may invoke across buckets.
2. **Bucket Policies (Resource-Based)**:
   JSON policy documents attached directly to an S3 bucket. Controls access at the bucket/prefix level (e.g., denying all anonymous principals or allowing `s3:GetObject` only on a specific public sandbox bucket).
3. **Object Permissions / Pre-Signed URLs**:
   Individual object ACLs (legacy/discouraged in modern S3 via `BucketOwnerEnforced`) or **cryptographic pre-signed URLs**, which grant temporary, time-bounded bearer read access to a single private object without opening the bucket to the public.

In this project:
- **`cloud-organizer-private`** is strictly private. Direct anonymous URLs (`http://localhost:9000/cloud-organizer-private/documents/file.pdf`) always return `403 Forbidden`.
- **`cloud-organizer-public-sandbox`** is a separate disposable bucket used only when the operator checks the explicit confirmation box to demonstrate public-read bucket policies.

---

## 9. How to Generate and Test Pre-Signed URLs

1. In the dashboard, select any private object from the **Object Explorer**.
2. Open the **Pre-Signed URLs** tab and select an expiration duration (`60 seconds`, `5 minutes`, or `15 minutes`).
3. Click **Generate Pre-Signed URL**.
4. Test the generated URL using `curl` or PowerShell:

**Linux / macOS:**
```bash
# Direct unauthenticated URL fails with HTTP 403 Forbidden:
curl -i "http://localhost:9000/cloud-organizer-private/reports/financial_summary.csv"

# Pre-signed URL succeeds with HTTP 200 OK before expiration:
curl -i "<PASTE_GENERATED_PRESIGNED_URL>"
```

**Windows PowerShell:**
```powershell
# Direct unauthenticated URL fails with 403:
Invoke-WebRequest -Uri "http://localhost:9000/cloud-organizer-private/reports/financial_summary.csv"

# Pre-signed URL succeeds before expiration:
Invoke-WebRequest -Uri "<PASTE_GENERATED_PRESIGNED_URL>" -OutFile downloaded_report.csv
```

---

## 10. How to Test URL Expiration

1. Generate a pre-signed URL with a `60 seconds` expiration (or `1 second` via `manager.generate_presigned_url(key, expiration_seconds=1)`).
2. Immediately fetch the URL — verify `HTTP 200 OK`.
3. Wait for the expiration window to elapse.
4. Request the exact same URL again — the S3/MinIO server verifies `X-Amz-Date` + `X-Amz-Expires` against the current UTC clock and rejects the request with `HTTP 403 Forbidden (RequestHasExpired)`.

---

## 11. How to Run Automated Tests

The test suite in `tests/test_storage_manager.py` and `tests/test_security.py` covers all 10 required verification scenarios, including live HTTP pre-signed URL expiration and anonymous access rejection.

**Run with Pytest (Windows PowerShell & Linux / macOS):**
```bash
pytest -v
```

**Run with Python Standard Library Unittest:**
```bash
python3 -m unittest discover -s tests -v
```

---

## 12. Troubleshooting Instructions

- **`Connection refused` on `http://localhost:9000`**:
  Ensure Docker Desktop / Docker Engine is running and start MinIO with `docker compose up -d`.
- **`AccessDenied` when uploading to sandbox bucket**:
  Public-read demonstration mode is disabled by default. Enable it in the sidebar with the confirmation checkbox before uploading to the sandbox bucket.
- **`SignatureDoesNotMatch` on Pre-Signed URLs**:
  Ensure your host system clock is synchronized via NTP and that `S3_ENDPOINT_URL` matches the hostname used to sign the request.
- **`StorageConfigError: Path traversal sequences are prohibited`**:
  Filenames containing `../`, `/`, `\`, or leading dots (`.env`) are blocked by `sanitize_filename()` to protect the host filesystem.

---

## 13. Security Considerations and AWS S3 Deployment Instructions

### Security Controls Implemented
- **Private-by-Default**: Main bucket blocks all anonymous access.
- **Zero Secret Leakage**: `StorageConfig` sets `repr=False` on `secret_key` and masks credentials via `mask_secret()`.
- **Path Traversal Prevention**: `sanitize_filename()` strips directory components and verifies resolved download paths remain inside `storage/`.
- **Bearer Token Awareness**: Pre-signed URLs act as temporary bearer tokens; anyone possessing the link can read the target object until `X-Amz-Expires` elapses. Always choose the shortest practical TTL.

### Switching from Local MinIO to Production AWS S3
1. Create a private S3 bucket in AWS with **Block Public Access (All 4 settings ON)** and **Bucket Owner Enforced** object ownership.
2. Create a least-privilege IAM policy scoped only to your bucket ARN:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": [
           "s3:ListBucket",
           "s3:GetBucketLocation"
         ],
         "Resource": "arn:aws:s3:::your-production-private-bucket"
       },
       {
         "Effect": "Allow",
         "Action": [
           "s3:PutObject",
           "s3:GetObject",
           "s3:DeleteObject",
           "s3:GetObjectTagging",
           "s3:PutObjectTagging"
         ],
         "Resource": "arn:aws:s3:::your-production-private-bucket/*"
       }
     ]
   }
   ```
3. Update `.env`:
   ```ini
   S3_ENDPOINT_URL="https://s3.us-east-1.amazonaws.com"
   S3_ACCESS_KEY="<YOUR_IAM_ACCESS_KEY_ID>"
   S3_SECRET_KEY="<YOUR_IAM_SECRET_ACCESS_KEY>"
   S3_BUCKET_NAME="your-production-private-bucket"
   S3_REGION="us-east-1"
   ```

---

## 14. Screenshots Section for Final Submission

Include screenshots of the following verification steps in your final submission portfolio:
1. **MinIO Container & Bucket Initialization**: Terminal output of `docker compose up -d` and MinIO Console (`http://localhost:9001`) showing `cloud-organizer-private`.
2. **Categorized File Upload with Metadata & Tags**: Uploading files into `documents/`, `images/`, `reports/`, and `projects/`.
3. **Private Object Anonymous Rejection (`HTTP 403`)**: Browser or `curl` output showing `AccessDenied` when requesting a private object without a signature.
4. **Pre-Signed URL Generation & Verified Access (`HTTP 200`)**: Accessing the private object using the generated HMAC-SHA256 pre-signed URL before expiry.
5. **Expired Pre-Signed URL Rejection (`HTTP 403`)**: Attempting to use the same pre-signed URL after the TTL expires.
6. **Automated Pytest Suite Passing**: Terminal screenshot showing all 10 test scenarios passing.

## 15.Output
<img width="1920" height="1080" alt="image" src="https://github.com/user-attachments/assets/0015a417-ca1d-465e-b70e-bda6f1bdc848" />
<img width="1920" height="1080" alt="image" src="https://github.com/user-attachments/assets/1ecf34db-2fec-418d-8bdd-d19b35428181" />
<img width="1920" height="1080" alt="image" src="https://github.com/user-attachments/assets/854585c3-aa5b-4251-ac8e-ab3014e7bfe8" />


